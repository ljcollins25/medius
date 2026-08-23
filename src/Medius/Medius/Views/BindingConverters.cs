using System.Globalization;
using Avalonia.Data.Converters;

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
