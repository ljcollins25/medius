using System.Runtime.InteropServices.JavaScript;
using System.Runtime.Versioning;
using System.Text.Json;
using Medius.Core;
using Medius.Services;

namespace Medius.Browser;

[SupportedOSPlatform("browser")]
internal sealed partial class BrowserPlaybackHost : IPlaybackHost
{
    public async Task PlayAsync(
        PlaybackPlan plan,
        string? subtitleWebVtt,
        double embeddedSubtitleOffsetMilliseconds,
        CancellationToken cancellationToken = default) =>
        _ = await PlayVideoAsync(
            plan.Content.Uri.ToString(),
            plan.Video.Name,
            plan.Mode.ToString(),
            subtitleWebVtt,
            embeddedSubtitleOffsetMilliseconds);

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

    [JSImport("playVideo", "medius-player")]
    [return: JSMarshalAs<JSType.Promise<JSType.Boolean>>]
    private static partial Task<bool> PlayVideoAsync(
        string uri,
        string fileName,
        string mode,
        string? subtitleWebVtt,
        double embeddedSubtitleOffsetMilliseconds);

    [JSImport("pickSubtitle", "medius-player")]
    [return: JSMarshalAs<JSType.Promise<JSType.String>>]
    private static partial Task<string?> PickSubtitleFileAsync();
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
