using System.Globalization;
using Avalonia.Data.Converters;
using Medius.Core;

namespace Medius.Views;

public static class BoolConverters
{
    public static readonly IValueConverter FolderOrFile =
        new FuncValueConverter<bool, string>(value => value ? "▸" : "•");
}

public static class SizeConverters
{
    public static readonly IValueConverter ByteSize =
        new FuncValueConverter<long?, string>(value =>
        {
            if (value is null)
            {
                return string.Empty;
            }

            string[] units = ["B", "KB", "MB", "GB", "TB"];
            var size = (double)value.Value;
            var unit = 0;
            while (size >= 1024 && unit < units.Length - 1)
            {
                size /= 1024;
                unit++;
            }

            return unit == 0 ? $"{size:0} {units[unit]}" : $"{size:0.##} {units[unit]}";
        });
}

public static class ItemConverters
{
    public static readonly IValueConverter Icon =
        new FuncValueConverter<MediaItem, string>(item =>
            item is null
                ? "•"
                : item.IsDirectory
                ? "▰"
                : MediaTypes.IsVideo(item)
                    ? "▶"
                    : MediaTypes.IsSubtitle(item)
                        ? "CC"
                        : "•");

    public static readonly IValueConverter Detail =
        new FuncValueConverter<MediaItem, string>(item =>
            item is null
                ? string.Empty
                : item.IsDirectory
                ? "Folder"
                : MediaTypes.IsVideo(item)
                    ? $"{item.Extension.TrimStart('.').ToUpperInvariant()} video"
                    : MediaTypes.IsSubtitle(item)
                        ? $"{item.Extension.TrimStart('.').ToUpperInvariant()} subtitles"
                        : item.Extension.TrimStart('.').ToUpperInvariant());
}
