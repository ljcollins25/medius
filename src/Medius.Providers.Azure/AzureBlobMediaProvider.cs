using Azure.Storage.Blobs;
using Azure.Storage.Blobs.Models;
using Azure.Storage.Blobs.Specialized;
using Azure.Storage.Sas;
using Medius.Core;
using System.Net.Http.Headers;
using System.Text;

namespace Medius.Providers.Azure;

public sealed class AzureBlobMediaProvider : IMediaProvider, IWritableAppDataProvider
{
    private readonly BlobContainerClient _container;
    private readonly AzureBlobOptions _options;
    private readonly GhostBlobHydrator _hydrator = new();
    private static readonly HttpClient HttpClient = new();

    public AzureBlobMediaProvider(AzureBlobOptions options)
    {
        _options = options;
        _container = StorageClientFactory.CreateBlobContainer(options);
    }

    public string DisplayName => $"Azure Blob · {_container.Name}";

    public async Task<IReadOnlyList<MediaItem>> ListAsync(
        string path,
        CancellationToken cancellationToken = default)
    {
        var prefix = CombinePath(_options.RootPrefix, path);
        if (prefix.Length > 0 && !prefix.EndsWith('/'))
        {
            prefix += "/";
        }

        var items = new List<MediaItem>();
        await foreach (var page in _container
            .GetBlobsByHierarchyAsync(
                BlobTraits.Metadata | BlobTraits.Tags,
                delimiter: "/",
                prefix: prefix,
                cancellationToken: cancellationToken)
            .AsPages())
        {
            foreach (var entry in page.Values)
            {
                if (entry.IsPrefix)
                {
                    var directoryPath = TrimRoot(entry.Prefix!.TrimEnd('/'));
                    items.Add(new MediaItem(directoryPath, Path.GetFileName(directoryPath), true));
                    continue;
                }

                var blob = entry.Blob;
                var itemPath = TrimRoot(blob.Name);
                var size = GetEffectiveSize(blob);
                items.Add(new MediaItem(
                    itemPath,
                    Path.GetFileName(itemPath),
                    false,
                    size,
                    blob.Properties.LastModified,
                    blob.Properties.ContentType,
                    GetMetadataAndTags(blob)));
            }
        }

        return items
            .OrderByDescending(item => item.IsDirectory)
            .ThenBy(item => item.Name, StringComparer.OrdinalIgnoreCase)
            .ToArray();
    }

    public async Task<MediaContent> GetContentAsync(
        MediaItem item,
        CancellationToken cancellationToken = default)
    {
        var blob = _container.GetBlockBlobClient(CombinePath(_options.RootPrefix, item.Path));
        if (IsGhost(item))
        {
            await _hydrator.HydrateIfNeededAsync(blob, cancellationToken);
        }

        var properties = await blob.GetPropertiesAsync(cancellationToken: cancellationToken);
        return new MediaContent(GetReadUri(blob), properties.Value.ContentType, properties.Value.ContentLength);
    }

    public async Task<Stream> OpenReadAsync(MediaItem item, CancellationToken cancellationToken = default)
    {
        var blob = _container.GetBlockBlobClient(CombinePath(_options.RootPrefix, item.Path));
        if (IsGhost(item))
        {
            await _hydrator.HydrateIfNeededAsync(blob, cancellationToken);
        }

        using var request = new HttpRequestMessage(HttpMethod.Get, GetReadUri(blob));
        if (!string.IsNullOrWhiteSpace(_options.AccessToken))
        {
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _options.AccessToken);
            request.Headers.TryAddWithoutValidation("x-ms-version", "2023-11-03");
        }

        using var response = await HttpClient.SendAsync(request, cancellationToken);
        response.EnsureSuccessStatusCode();
        var content = await response.Content.ReadAsByteArrayAsync(cancellationToken);
        return new MemoryStream(content, writable: false);
    }

    public async Task<string?> ReadTextAsync(string path, CancellationToken cancellationToken = default)
    {
        var blob = _container.GetBlockBlobClient(CombinePath(_options.RootPrefix, path));
        if (!await blob.ExistsAsync(cancellationToken))
        {
            return null;
        }

        var download = await blob.DownloadContentAsync(cancellationToken);
        return download.Value.Content.ToString();
    }

    public async Task WriteTextAsync(string path, string content, CancellationToken cancellationToken = default)
    {
        var blob = _container.GetBlockBlobClient(CombinePath(_options.RootPrefix, path));
        var bytes = Encoding.UTF8.GetBytes(content);
        using var stream = new MemoryStream(bytes);
        await blob.UploadAsync(
            stream,
            new BlobUploadOptions { HttpHeaders = new BlobHttpHeaders { ContentType = "application/json" } },
            cancellationToken);
    }

    private static long? GetEffectiveSize(BlobItem blob)
    {
        if (blob.Properties.ContentLength is > 0)
        {
            return blob.Properties.ContentLength;
        }

        return blob.Tags is not null
            && blob.Tags.TryGetValue(GhostBlobHydrator.StateTag, out var state)
            && state.Equals("ghost", StringComparison.OrdinalIgnoreCase)
            && blob.Tags.TryGetValue(GhostBlobHydrator.SizeTag, out var size)
            && long.TryParse(size, out var parsed)
                ? parsed
                : blob.Properties.ContentLength;
    }

    private static bool IsGhost(MediaItem item) =>
        item.Metadata?.TryGetValue(GhostBlobHydrator.StateTag, out var state) == true
        && state.Equals("ghost", StringComparison.OrdinalIgnoreCase);

    private static IReadOnlyDictionary<string, string>? GetMetadataAndTags(BlobItem blob)
    {
        if (blob.Metadata is null && blob.Tags is null)
        {
            return null;
        }

        var values = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        if (blob.Metadata is not null)
        {
            foreach (var item in blob.Metadata)
            {
                values[item.Key] = item.Value;
            }
        }

        if (blob.Tags is not null)
        {
            foreach (var item in blob.Tags)
            {
                values[item.Key] = item.Value;
            }
        }

        return values;
    }

    private Uri GetReadUri(BlockBlobClient blob)
    {
        if (blob.CanGenerateSasUri)
        {
            return blob.GenerateSasUri(BlobSasPermissions.Read, DateTimeOffset.UtcNow.AddHours(8));
        }

        return blob.Uri;
    }

    private string TrimRoot(string path)
    {
        var root = _options.RootPrefix.Trim('/');
        return root.Length > 0 && path.StartsWith(root + "/", StringComparison.OrdinalIgnoreCase)
            ? path[(root.Length + 1)..]
            : path;
    }

    private static string CombinePath(string left, string right) =>
        string.Join("/", new[] { left.Trim('/'), right.Trim('/') }.Where(value => value.Length > 0));
}
