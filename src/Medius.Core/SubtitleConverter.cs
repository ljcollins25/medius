using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;

namespace Medius.Core;

public static partial class SubtitleConverter
{
    public static string ToWebVtt(string subtitle, string extension, TimeSpan offset)
    {
        ArgumentNullException.ThrowIfNull(subtitle);

        extension = extension.ToLowerInvariant();
        if (extension is not ".srt" and not ".vtt")
        {
            throw new NotSupportedException($"{extension} subtitles require ffmpeg conversion.");
        }

        var normalized = subtitle.Replace("\r\n", "\n", StringComparison.Ordinal).Replace('\r', '\n');
        var body = extension == ".vtt"
            ? RemoveVttHeader(normalized)
            : normalized.Replace(',', '.');

        body = CueTimeRegex().Replace(body, match =>
        {
            var start = Shift(ParseTimestamp(match.Groups["start"].Value), offset);
            var end = Shift(ParseTimestamp(match.Groups["end"].Value), offset);
            return $"{FormatTimestamp(start)} --> {FormatTimestamp(end)}{match.Groups["settings"].Value}";
        });

        return "WEBVTT\n\n" + body.TrimStart();
    }

    private static string RemoveVttHeader(string value)
    {
        if (!value.StartsWith("WEBVTT", StringComparison.OrdinalIgnoreCase))
        {
            return value;
        }

        var separator = value.IndexOf("\n\n", StringComparison.Ordinal);
        return separator < 0 ? string.Empty : value[(separator + 2)..];
    }

    private static TimeSpan ParseTimestamp(string value)
    {
        var parts = value.Split(':');
        return parts.Length switch
        {
            2 => TimeSpan.FromMinutes(int.Parse(parts[0], CultureInfo.InvariantCulture))
                + TimeSpan.FromSeconds(double.Parse(parts[1], CultureInfo.InvariantCulture)),
            3 => TimeSpan.FromHours(int.Parse(parts[0], CultureInfo.InvariantCulture))
                + TimeSpan.FromMinutes(int.Parse(parts[1], CultureInfo.InvariantCulture))
                + TimeSpan.FromSeconds(double.Parse(parts[2], CultureInfo.InvariantCulture)),
            _ => throw new FormatException($"Invalid subtitle timestamp '{value}'.")
        };
    }

    private static TimeSpan Shift(TimeSpan value, TimeSpan offset)
    {
        var shifted = value + offset;
        return shifted < TimeSpan.Zero ? TimeSpan.Zero : shifted;
    }

    private static string FormatTimestamp(TimeSpan value)
    {
        var totalHours = (long)value.TotalHours;
        return string.Create(
            CultureInfo.InvariantCulture,
            $"{totalHours:00}:{value.Minutes:00}:{value.Seconds:00}.{value.Milliseconds:000}");
    }

    [GeneratedRegex(
        @"(?<start>(?:\d{1,3}:)?\d{2}:\d{2}[\.,]\d{3})\s*-->\s*(?<end>(?:\d{1,3}:)?\d{2}:\d{2}[\.,]\d{3})(?<settings>[^\r\n]*)",
        RegexOptions.CultureInvariant)]
    private static partial Regex CueTimeRegex();
}
