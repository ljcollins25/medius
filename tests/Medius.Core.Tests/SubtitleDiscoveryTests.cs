using Medius.Core;

namespace Medius.Core.Tests;

public sealed class SubtitleDiscoveryTests
{
    [Fact]
    public void FindsStandardAdjacentNamesOnly()
    {
        var video = Item("Movie.mkv");
        var items = new[]
        {
            Item("Movie.en.srt"),
            Item("Movie-forced.vtt"),
            Item("Movie_commentary.ass"),
            Item("Movie2.srt"),
            Item("Other.srt")
        };

        var result = SubtitleDiscovery.FindAdjacent(video, items);

        Assert.Equal(3, result.Count);
        Assert.DoesNotContain(result, item => item.Name == "Movie2.srt");
    }

    private static MediaItem Item(string name) => new(name, name, false);
}
