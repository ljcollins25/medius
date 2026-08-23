using Medius.Core;

namespace Medius.Core.Tests;

public sealed class PlaybackPlannerTests
{
    [Theory]
    [InlineData("movie.mp4", PlaybackMode.Direct)]
    [InlineData("movie.mkv", PlaybackMode.Remux)]
    [InlineData("movie.avi", PlaybackMode.Transcode)]
    public void SelectsExpectedPlaybackMode(string name, PlaybackMode expected)
    {
        var video = new MediaItem(name, name, false);
        var content = new MediaContent(new Uri("https://example.test/media"), null, null);

        var plan = PlaybackPlanner.Create(video, content, []);

        Assert.Equal(expected, plan.Mode);
    }
}
