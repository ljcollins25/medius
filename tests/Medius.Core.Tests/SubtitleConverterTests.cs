using Medius.Core;

namespace Medius.Core.Tests;

public sealed class SubtitleConverterTests
{
    [Fact]
    public void ConvertsSrtAndAppliesPositiveOffset()
    {
        const string source = "1\r\n00:00:01,250 --> 00:00:03,500\r\nHello\r\n";

        var result = SubtitleConverter.ToWebVtt(source, ".srt", TimeSpan.FromMilliseconds(750));

        Assert.Contains("00:00:02.000 --> 00:00:04.250", result);
        Assert.StartsWith("WEBVTT", result);
    }

    [Fact]
    public void ClampsNegativeOffsetAtZero()
    {
        const string source = "WEBVTT\n\n00:01.000 --> 00:02.000\nHello\n";

        var result = SubtitleConverter.ToWebVtt(source, ".vtt", TimeSpan.FromSeconds(-1.5));

        Assert.Contains("00:00:00.000 --> 00:00:00.500", result);
    }
}
