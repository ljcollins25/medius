namespace Medius.Providers.Azure;

/// <summary>
/// A media provider that can also read and write small pieces of arbitrary UTF-8 text,
/// used to bootstrap and persist the encrypted cloud app-state document.
/// </summary>
public interface IWritableAppDataProvider
{
    /// <summary>
    /// Reads the UTF-8 text stored at <paramref name="path"/>, or <see langword="null"/> when nothing exists there yet.
    /// </summary>
    Task<string?> ReadTextAsync(string path, CancellationToken cancellationToken = default);

    /// <summary>
    /// Writes <paramref name="content"/> as UTF-8 text to <paramref name="path"/>, creating or overwriting it.
    /// </summary>
    Task WriteTextAsync(string path, string content, CancellationToken cancellationToken = default);
}
