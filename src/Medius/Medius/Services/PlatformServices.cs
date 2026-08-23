using Medius.Core;

namespace Medius.Services;

public static class PlatformServices
{
    public static IPlaybackHost Playback { get; set; } = new UnsupportedPlaybackHost();

    public static IWebAuthenticationHost Authentication { get; set; } = new UnsupportedAuthenticationHost();

    public static IMountStore Mounts { get; set; } = new MemoryMountStore();

    public static IOfflineMediaStore Offline { get; set; } = new UnsupportedOfflineMediaStore();

    public static IAppStateProtector StateProtector { get; set; } = new DotNetAppStateProtector();

    public static IPortableAppDataHost PortableAppData { get; set; } = new UnsupportedPortableAppDataHost();
}

public interface IPlaybackHost
{
    Task StopAndShowLoadingAsync(string fileName, CancellationToken cancellationToken = default);

    Task PlayAsync(
        PlaybackPlan plan,
        string? subtitleWebVtt,
        double embeddedSubtitleOffsetMilliseconds,
        double? startSeconds = null,
        double? endSeconds = null,
        string? mediaKey = null,
        int maxWidth = 854,
        long convertedCacheLimitBytes = 536870912,
        CancellationToken cancellationToken = default);

    Task SetSubtitleAsync(string? subtitleWebVtt, CancellationToken cancellationToken = default);

    Task SetSubtitleStyleAsync(
        double fontSizePercent,
        double backgroundOpacity,
        CancellationToken cancellationToken = default);

    Task<LocalSubtitle?> PickSubtitleAsync(CancellationToken cancellationToken = default);

    Task ClearConvertedCacheAsync(CancellationToken cancellationToken = default);

    Task<long> GetConvertedCacheUsageAsync(CancellationToken cancellationToken = default);
}

public sealed record LocalSubtitle(string Name, string Content);

public interface IWebAuthenticationHost
{
    Task<string> AcquireTokenAsync(
        string tenantId,
        string clientId,
        IReadOnlyList<string> scopes,
        CancellationToken cancellationToken = default);
}

public interface IMountStore
{
    Task<string?> LoadAsync(CancellationToken cancellationToken = default);

    Task SaveAsync(string json, CancellationToken cancellationToken = default);
}

public sealed record OfflineStorageEstimate(long Usage, long Quota);

public interface IOfflineMediaStore
{
    Task CacheAsync(
        string key,
        Uri source,
        string? bearerToken = null,
        CancellationToken cancellationToken = default);

    Task<Uri?> ResolveAsync(string key, CancellationToken cancellationToken = default);

    Task<bool> RemoveAsync(string key, CancellationToken cancellationToken = default);

    Task<OfflineStorageEstimate> EstimateAsync(CancellationToken cancellationToken = default);
}

public interface IAppStateProtector
{
    Task<string> EncryptAsync(string plaintextJson, string passphrase);

    Task<string> DecryptAsync(string envelopeJson, string passphrase);
}

public interface IPortableAppDataHost
{
    Task ExportFileAsync(string fileName, string content);

    Task<string?> ImportFileAsync();

    Task ShowQrAsync(string payload);

    Task<string?> ScanQrCameraAsync();

    Task<string?> ScanQrFileAsync();
}

internal sealed class UnsupportedPlaybackHost : IPlaybackHost
{
    public Task StopAndShowLoadingAsync(string fileName, CancellationToken cancellationToken = default) =>
        Task.CompletedTask;

    public Task PlayAsync(
        PlaybackPlan plan,
        string? subtitleWebVtt,
        double embeddedSubtitleOffsetMilliseconds,
        double? startSeconds = null,
        double? endSeconds = null,
        string? mediaKey = null,
        int maxWidth = 854,
        long convertedCacheLimitBytes = 536870912,
        CancellationToken cancellationToken = default) =>
        throw new PlatformNotSupportedException("HTML5 playback is available in the browser head.");

    public Task SetSubtitleAsync(string? subtitleWebVtt, CancellationToken cancellationToken = default) =>
        throw new PlatformNotSupportedException("HTML5 subtitles are available in the browser head.");

    public Task SetSubtitleStyleAsync(
        double fontSizePercent,
        double backgroundOpacity,
        CancellationToken cancellationToken = default) =>
        Task.CompletedTask;

    public Task<LocalSubtitle?> PickSubtitleAsync(CancellationToken cancellationToken = default) =>
        throw new PlatformNotSupportedException("Local subtitle selection is available in the browser head.");

    public Task ClearConvertedCacheAsync(CancellationToken cancellationToken = default) =>
        Task.CompletedTask;

    public Task<long> GetConvertedCacheUsageAsync(CancellationToken cancellationToken = default) =>
        Task.FromResult(0L);
}

internal sealed class UnsupportedAuthenticationHost : IWebAuthenticationHost
{
    public Task<string> AcquireTokenAsync(
        string tenantId,
        string clientId,
        IReadOnlyList<string> scopes,
        CancellationToken cancellationToken = default) =>
        throw new PlatformNotSupportedException("Interactive OAuth is available in the browser head.");
}

internal sealed class MemoryMountStore : IMountStore
{
    private string? _json;

    public Task<string?> LoadAsync(CancellationToken cancellationToken = default) => Task.FromResult(_json);

    public Task SaveAsync(string json, CancellationToken cancellationToken = default)
    {
        _json = json;
        return Task.CompletedTask;
    }
}

internal sealed class UnsupportedOfflineMediaStore : IOfflineMediaStore
{
    public Task CacheAsync(
        string key,
        Uri source,
        string? bearerToken = null,
        CancellationToken cancellationToken = default) =>
        throw new PlatformNotSupportedException("Offline media storage is not configured.");

    public Task<Uri?> ResolveAsync(string key, CancellationToken cancellationToken = default) =>
        Task.FromResult<Uri?>(null);

    public Task<bool> RemoveAsync(string key, CancellationToken cancellationToken = default) =>
        Task.FromResult(false);

    public Task<OfflineStorageEstimate> EstimateAsync(CancellationToken cancellationToken = default) =>
        Task.FromResult(new OfflineStorageEstimate(0, 0));
}

internal sealed class DotNetAppStateProtector : IAppStateProtector
{
    public Task<string> EncryptAsync(string plaintextJson, string passphrase) =>
        Task.FromResult(AppStateCrypto.Encrypt(plaintextJson, passphrase));

    public Task<string> DecryptAsync(string envelopeJson, string passphrase) =>
        Task.FromResult(AppStateCrypto.Decrypt(envelopeJson, passphrase));
}

internal sealed class UnsupportedPortableAppDataHost : IPortableAppDataHost
{
    public Task ExportFileAsync(string fileName, string content) =>
        throw new PlatformNotSupportedException("Portable app-data export is unavailable.");

    public Task<string?> ImportFileAsync() =>
        throw new PlatformNotSupportedException("Portable app-data import is unavailable.");

    public Task ShowQrAsync(string payload) =>
        throw new PlatformNotSupportedException("QR display is unavailable.");

    public Task<string?> ScanQrCameraAsync() =>
        throw new PlatformNotSupportedException("QR camera scanning is unavailable.");

    public Task<string?> ScanQrFileAsync() =>
        throw new PlatformNotSupportedException("QR image scanning is unavailable.");
}
