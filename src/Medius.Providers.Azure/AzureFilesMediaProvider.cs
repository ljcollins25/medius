using Azure.Storage.Files.Shares;
using Azure.Storage.Sas;
using Medius.Core;

namespace Medius.Providers.Azure;

public sealed class AzureFilesMediaProvider : IMediaProvider
{
    private readonly ShareClient _share;
    private readonly AzureFilesOptions _options;

    public AzureFilesMediaProvider(AzureFilesOptions options)
    {
        _options = options;
        _share = StorageClientFactory.CreateShare(options);
    }

    public string DisplayName => $"Azure Files · {_share.Name}";

    public async Task<IReadOnlyList<MediaItem>> ListAsync(
        string path,
        CancellationToken cancellationToken = default)
    {
        var directory = _share.GetDirectoryClient(CombinePath(_options.RootPath, path));
        var items = new List<MediaItem>();
        await foreach (var entry in directory.GetFilesAndDirectoriesAsync(cancellationToken: cancellationToken))
        {
            items.Add(new MediaItem(
                CombinePath(path, entry.Name),
                entry.Name,
                entry.IsDirectory,
                entry.FileSize,
                entry.Properties?.LastModified));
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
        var file = GetFile(item.Path);
        var properties = await file.GetPropertiesAsync(cancellationToken: cancellationToken);
        var uri = file.CanGenerateSasUri
            ? file.GenerateSasUri(ShareFileSasPermissions.Read, DateTimeOffset.UtcNow.AddHours(8))
            : file.Uri;
        return new MediaContent(uri, properties.Value.ContentType, properties.Value.ContentLength);
    }

    public async Task<Stream> OpenReadAsync(MediaItem item, CancellationToken cancellationToken = default) =>
        await GetFile(item.Path).OpenReadAsync(cancellationToken: cancellationToken);

    private global::Azure.Storage.Files.Shares.ShareFileClient GetFile(string path)
    {
        var fullPath = CombinePath(_options.RootPath, path);
        var directoryPath = Path.GetDirectoryName(fullPath)?.Replace('\\', '/') ?? string.Empty;
        return _share.GetDirectoryClient(directoryPath).GetFileClient(Path.GetFileName(fullPath));
    }

    private static string CombinePath(string left, string right) =>
        string.Join("/", new[] { left.Trim('/'), right.Trim('/') }.Where(value => value.Length > 0));
}
