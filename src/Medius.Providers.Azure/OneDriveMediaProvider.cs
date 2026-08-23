using System.Net.Http.Headers;
using System.Text.Json;
using Medius.Core;

namespace Medius.Providers.Azure;

public sealed class OneDriveMediaProvider : IMediaProvider, IWritableAppDataProvider, IDisposable
{
    private const string GraphRoot = "https://graph.microsoft.com/v1.0/me/drive";
    private readonly HttpClient _httpClient;
    private readonly string _rootPath;

    public OneDriveMediaProvider(string accessToken, string rootPath = "", HttpMessageHandler? handler = null)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(accessToken);
        _rootPath = rootPath.Trim('/');
        _httpClient = handler is null ? new HttpClient() : new HttpClient(handler);
        _httpClient.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", accessToken);
    }

    public string DisplayName => "OneDrive";

    public async Task<IReadOnlyList<MediaItem>> ListAsync(
        string path,
        CancellationToken cancellationToken = default)
    {
        var fullPath = CombinePath(_rootPath, path);
        var url = fullPath.Length == 0
            ? $"{GraphRoot}/root/children?$select=name,size,lastModifiedDateTime,file,folder,@microsoft.graph.downloadUrl"
            : $"{GraphRoot}/root:/{Uri.EscapeDataString(fullPath).Replace("%2F", "/", StringComparison.OrdinalIgnoreCase)}:/children?$select=name,size,lastModifiedDateTime,file,folder,@microsoft.graph.downloadUrl";
        using var response = await _httpClient.GetAsync(url, cancellationToken);
        response.EnsureSuccessStatusCode();
        await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
        using var document = await JsonDocument.ParseAsync(stream, cancellationToken: cancellationToken);

        return document.RootElement.GetProperty("value").EnumerateArray()
            .Select(element =>
            {
                var name = element.GetProperty("name").GetString()!;
                var isDirectory = element.TryGetProperty("folder", out _);
                var metadata = new Dictionary<string, string>();
                if (element.TryGetProperty("@microsoft.graph.downloadUrl", out var downloadUrl))
                {
                    metadata["downloadUrl"] = downloadUrl.GetString()!;
                }

                return new MediaItem(
                    CombinePath(path, name),
                    name,
                    isDirectory,
                    element.TryGetProperty("size", out var size) ? size.GetInt64() : null,
                    element.TryGetProperty("lastModifiedDateTime", out var modified)
                        ? modified.GetDateTimeOffset()
                        : null,
                    element.TryGetProperty("file", out var file)
                        && file.TryGetProperty("mimeType", out var mime)
                            ? mime.GetString()
                            : null,
                    metadata);
            })
            .OrderByDescending(item => item.IsDirectory)
            .ThenBy(item => item.Name, StringComparer.OrdinalIgnoreCase)
            .ToArray();
    }

    public Task<MediaContent> GetContentAsync(MediaItem item, CancellationToken cancellationToken = default)
    {
        if (item.Metadata is null || !item.Metadata.TryGetValue("downloadUrl", out var url))
        {
            throw new InvalidOperationException($"OneDrive did not return a download URL for '{item.Name}'.");
        }

        return Task.FromResult(new MediaContent(new Uri(url), item.ContentType, item.Size));
    }

    public async Task<Stream> OpenReadAsync(MediaItem item, CancellationToken cancellationToken = default)
    {
        var content = await GetContentAsync(item, cancellationToken);
        return await _httpClient.GetStreamAsync(content.Uri, cancellationToken);
    }

    public async Task<string?> ReadTextAsync(string path, CancellationToken cancellationToken = default)
    {
        var response = await _httpClient.GetAsync(GetContentUrl(path), cancellationToken);
        if (response.StatusCode == System.Net.HttpStatusCode.NotFound)
        {
            response.Dispose();
            return null;
        }
        using (response)
        {
            response.EnsureSuccessStatusCode();
            return await response.Content.ReadAsStringAsync(cancellationToken);
        }
    }

    public async Task WriteTextAsync(
        string path,
        string content,
        CancellationToken cancellationToken = default)
    {
        using var body = new StringContent(content, System.Text.Encoding.UTF8, "application/json");
        using var response = await _httpClient.PutAsync(GetContentUrl(path), body, cancellationToken);
        response.EnsureSuccessStatusCode();
    }

    public void Dispose() => _httpClient.Dispose();

    private static string CombinePath(string left, string right) =>
        string.Join("/", new[] { left.Trim('/'), right.Trim('/') }.Where(value => value.Length > 0));

    private string GetContentUrl(string path)
    {
        var fullPath = CombinePath(_rootPath, path);
        return $"{GraphRoot}/root:/{Uri.EscapeDataString(fullPath).Replace("%2F", "/", StringComparison.OrdinalIgnoreCase)}:/content";
    }
}
