using System.Runtime.InteropServices.JavaScript;
using System.Runtime.Versioning;
using System.Text.Json;
using Medius.Core;
using Medius.Services;

namespace Medius.Browser;

[SupportedOSPlatform("browser")]
internal sealed partial class BrowserPlaybackHost : IPlaybackHost
{
    public Task StopAndShowLoadingAsync(string fileName, CancellationToken cancellationToken = default)
    {
        PreparePlayback(fileName);
        return Task.CompletedTask;
    }

    public async Task PlayAsync(
        PlaybackPlan plan,
        string? subtitleWebVtt,
        double embeddedSubtitleOffsetMilliseconds,
        double? startSeconds = null,
        double? endSeconds = null,
        CancellationToken cancellationToken = default) =>
        _ = await PlayVideoAsync(
            plan.Content.Uri.ToString(),
            plan.Video.Name,
            plan.Mode.ToString(),
            subtitleWebVtt,
            embeddedSubtitleOffsetMilliseconds,
            startSeconds ?? -1,
            endSeconds ?? -1);

    public async Task<LocalSubtitle?> PickSubtitleAsync(CancellationToken cancellationToken = default)
    {
        var json = await PickSubtitleFileAsync();
        if (json is null)
        {
            return null;
        }

        using var document = JsonDocument.Parse(json);
        return new LocalSubtitle(
            document.RootElement.GetProperty("Name").GetString()!,
            document.RootElement.GetProperty("Content").GetString()!);
    }

    public Task SetSubtitleAsync(string? subtitleWebVtt, CancellationToken cancellationToken = default)
    {
        SetSubtitle(subtitleWebVtt);
        return Task.CompletedTask;
    }

    public Task SetSubtitleStyleAsync(
        double fontSizePercent,
        double backgroundOpacity,
        CancellationToken cancellationToken = default)
    {
        SetSubtitleStyle(fontSizePercent, backgroundOpacity);
        return Task.CompletedTask;
    }

    [JSImport("playVideo", "medius-player")]
    [return: JSMarshalAs<JSType.Promise<JSType.Boolean>>]
    private static partial Task<bool> PlayVideoAsync(
        string uri,
        string fileName,
        string mode,
        string? subtitleWebVtt,
        double embeddedSubtitleOffsetMilliseconds,
        double startSeconds,
        double endSeconds);

    [JSImport("pickSubtitle", "medius-player")]
    [return: JSMarshalAs<JSType.Promise<JSType.String>>]
    private static partial Task<string?> PickSubtitleFileAsync();

    [JSImport("setSubtitle", "medius-player")]
    private static partial void SetSubtitle(string? subtitleWebVtt);

    [JSImport("preparePlayback", "medius-player")]
    private static partial void PreparePlayback(string fileName);

    [JSImport("setSubtitleStyle", "medius-player")]
    private static partial void SetSubtitleStyle(double fontSizePercent, double backgroundOpacity);
}

[SupportedOSPlatform("browser")]
internal sealed partial class BrowserAuthenticationHost : IWebAuthenticationHost
{
    public Task<string> AcquireTokenAsync(
        string tenantId,
        string clientId,
        IReadOnlyList<string> scopes,
        CancellationToken cancellationToken = default) =>
        AcquireTokenCoreAsync(tenantId, clientId, string.Join(' ', scopes));

    [JSImport("acquireToken", "medius-player")]
    [return: JSMarshalAs<JSType.Promise<JSType.String>>]
    private static partial Task<string> AcquireTokenCoreAsync(string tenantId, string clientId, string scopes);
}

[SupportedOSPlatform("browser")]
internal sealed partial class BrowserMountStore : IMountStore
{
    public Task<string?> LoadAsync(CancellationToken cancellationToken = default) =>
        Task.FromResult(LoadMounts());

    public Task SaveAsync(string json, CancellationToken cancellationToken = default)
    {
        SaveMounts(json);
        return Task.CompletedTask;
    }

    [JSImport("loadMounts", "medius-player")]
    private static partial string? LoadMounts();

    [JSImport("saveMounts", "medius-player")]
    private static partial void SaveMounts(string json);
}

[SupportedOSPlatform("browser")]
internal sealed partial class BrowserOfflineMediaStore : IOfflineMediaStore
{
    public async Task CacheAsync(
        string key,
        Uri source,
        string? bearerToken = null,
        CancellationToken cancellationToken = default) =>
        _ = await CacheOfflineMediaAsync(key, source.ToString(), bearerToken);

    public async Task<Uri?> ResolveAsync(string key, CancellationToken cancellationToken = default)
    {
        var uri = await GetOfflineMediaUriAsync(key);
        return string.IsNullOrEmpty(uri) ? null : new Uri(uri, UriKind.Absolute);
    }

    public Task<bool> RemoveAsync(string key, CancellationToken cancellationToken = default) =>
        RemoveOfflineMediaAsync(key);

    public async Task<OfflineStorageEstimate> EstimateAsync(CancellationToken cancellationToken = default)
    {
        using var document = JsonDocument.Parse(await GetOfflineStorageEstimateAsync());
        return new OfflineStorageEstimate(
            document.RootElement.GetProperty("usage").GetInt64(),
            document.RootElement.GetProperty("quota").GetInt64());
    }

    [JSImport("cacheOfflineMedia", "medius-player")]
    [return: JSMarshalAs<JSType.Promise<JSType.Boolean>>]
    private static partial Task<bool> CacheOfflineMediaAsync(string key, string uri, string? bearerToken);

    [JSImport("removeOfflineMedia", "medius-player")]
    [return: JSMarshalAs<JSType.Promise<JSType.Boolean>>]
    private static partial Task<bool> RemoveOfflineMediaAsync(string key);

    [JSImport("getOfflineMediaUri", "medius-player")]
    [return: JSMarshalAs<JSType.Promise<JSType.String>>]
    private static partial Task<string?> GetOfflineMediaUriAsync(string key);

    [JSImport("getOfflineStorageEstimate", "medius-player")]
    [return: JSMarshalAs<JSType.Promise<JSType.String>>]
    private static partial Task<string> GetOfflineStorageEstimateAsync();
}

[SupportedOSPlatform("browser")]
internal sealed partial class BrowserAppStateProtector : IAppStateProtector
{
    public Task<string> EncryptAsync(string plaintextJson, string passphrase) =>
        EncryptAppStateAsync(plaintextJson, passphrase);

    public Task<string> DecryptAsync(string envelopeJson, string passphrase) =>
        DecryptAppStateAsync(envelopeJson, passphrase);

    [JSImport("encryptAppState", "medius-player")]
    [return: JSMarshalAs<JSType.Promise<JSType.String>>]
    private static partial Task<string> EncryptAppStateAsync(string plaintextJson, string passphrase);

    [JSImport("decryptAppState", "medius-player")]
    [return: JSMarshalAs<JSType.Promise<JSType.String>>]
    private static partial Task<string> DecryptAppStateAsync(string envelopeJson, string passphrase);
}
