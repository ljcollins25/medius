namespace Medius.Core;

public sealed record MediaItem(
    string Path,
    string Name,
    bool IsDirectory,
    long? Size = null,
    DateTimeOffset? LastModified = null,
    string? ContentType = null,
    IReadOnlyDictionary<string, string>? Metadata = null)
{
    public string Extension => System.IO.Path.GetExtension(Name).ToLowerInvariant();
}

public sealed record MediaContent(Uri Uri, string? ContentType, long? Size);

public interface IMediaProvider
{
    string DisplayName { get; }

    Task<IReadOnlyList<MediaItem>> ListAsync(string path, CancellationToken cancellationToken = default);

    Task<MediaContent> GetContentAsync(MediaItem item, CancellationToken cancellationToken = default);

    Task<Stream> OpenReadAsync(MediaItem item, CancellationToken cancellationToken = default);
}
