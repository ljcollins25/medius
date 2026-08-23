namespace Medius.Core;

public enum PlaybackMode
{
    Direct,
    Remux,
    Transcode
}

public sealed record PlaybackPlan(
    MediaItem Video,
    MediaContent Content,
    PlaybackMode Mode,
    IReadOnlyList<MediaItem> Subtitles,
    string? Reason);

public static class PlaybackPlanner
{
    private static readonly HashSet<string> DirectExtensions = new(
        [".mp4", ".m4v", ".webm"],
        StringComparer.OrdinalIgnoreCase);

    private static readonly HashSet<string> RemuxExtensions = new(
        [".mov", ".ts", ".m2ts"],
        StringComparer.OrdinalIgnoreCase);

    public static PlaybackPlan Create(
        MediaItem video,
        MediaContent content,
        IEnumerable<MediaItem> siblings)
    {
        if (!MediaTypes.IsVideo(video))
        {
            throw new ArgumentException("The selected item is not a recognized video.", nameof(video));
        }

        var subtitles = SubtitleDiscovery.FindAdjacent(video, siblings);
        if (DirectExtensions.Contains(video.Extension))
        {
            return new(video, content, PlaybackMode.Direct, subtitles, null);
        }

        if (RemuxExtensions.Contains(video.Extension))
        {
            return new(video, content, PlaybackMode.Remux, subtitles, "The container may need browser-side remuxing.");
        }

        return new(video, content, PlaybackMode.Transcode, subtitles, "The format requires browser-side transcoding.");
    }
}
