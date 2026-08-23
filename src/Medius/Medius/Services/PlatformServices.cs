using Medius.Core;

namespace Medius.Services;

public static class PlatformServices
{
    public static IPlaybackHost Playback { get; set; } = new UnsupportedPlaybackHost();

    public static IWebAuthenticationHost Authentication { get; set; } = new UnsupportedAuthenticationHost();

    public static IMountStore Mounts { get; set; } = new MemoryMountStore();
}

public interface IPlaybackHost
{
    Task StopAndShowLoadingAsync(string fileName, CancellationToken cancellationToken = default);

    Task PlayAsync(
        PlaybackPlan plan,
        string? subtitleWebVtt,
        double embeddedSubtitleOffsetMilliseconds,
        CancellationToken cancellationToken = default);

    Task SetSubtitleAsync(string? subtitleWebVtt, CancellationToken cancellationToken = default);

    Task SetSubtitleStyleAsync(
        double fontSizePercent,
        double backgroundOpacity,
        CancellationToken cancellationToken = default);

    Task<LocalSubtitle?> PickSubtitleAsync(CancellationToken cancellationToken = default);
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

internal sealed class UnsupportedPlaybackHost : IPlaybackHost
{
    public Task StopAndShowLoadingAsync(string fileName, CancellationToken cancellationToken = default) =>
        Task.CompletedTask;

    public Task PlayAsync(
        PlaybackPlan plan,
        string? subtitleWebVtt,
        double embeddedSubtitleOffsetMilliseconds,
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
