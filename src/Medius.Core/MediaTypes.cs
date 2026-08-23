namespace Medius.Core;

public static class MediaTypes
{
    public static readonly IReadOnlySet<string> VideoExtensions = new HashSet<string>(
        [".mp4", ".m4v", ".webm", ".mov", ".mkv", ".avi", ".wmv", ".mpeg", ".mpg", ".ts", ".m2ts"],
        StringComparer.OrdinalIgnoreCase);

    public static readonly IReadOnlySet<string> SubtitleExtensions = new HashSet<string>(
        [".vtt", ".srt", ".ass", ".ssa", ".sub"],
        StringComparer.OrdinalIgnoreCase);

    public static bool IsVideo(MediaItem item) => !item.IsDirectory && VideoExtensions.Contains(item.Extension);

    public static bool IsSubtitle(MediaItem item) => !item.IsDirectory && SubtitleExtensions.Contains(item.Extension);
}
