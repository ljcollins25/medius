namespace Medius.Core;

public static class SubtitleDiscovery
{
    public static IReadOnlyList<MediaItem> FindAdjacent(MediaItem video, IEnumerable<MediaItem> siblings)
    {
        var stem = Path.GetFileNameWithoutExtension(video.Name);
        return siblings
            .Where(MediaTypes.IsSubtitle)
            .Where(item =>
            {
                var subtitleStem = Path.GetFileNameWithoutExtension(item.Name);
                return subtitleStem.Equals(stem, StringComparison.OrdinalIgnoreCase)
                    || subtitleStem.StartsWith(stem + ".", StringComparison.OrdinalIgnoreCase)
                    || subtitleStem.StartsWith(stem + "-", StringComparison.OrdinalIgnoreCase)
                    || subtitleStem.StartsWith(stem + "_", StringComparison.OrdinalIgnoreCase);
            })
            .OrderBy(item => item.Name, StringComparer.OrdinalIgnoreCase)
            .ToArray();
    }
}
