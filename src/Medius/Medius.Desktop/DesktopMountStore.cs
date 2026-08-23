using System;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using Medius.Services;

namespace Medius.Desktop;

internal sealed class DesktopMountStore : IMountStore
{
    private static readonly string SettingsPath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "Medius",
        "mounts.json");

    public async Task<string?> LoadAsync(CancellationToken cancellationToken = default)
    {
        return File.Exists(SettingsPath)
            ? await File.ReadAllTextAsync(SettingsPath, cancellationToken)
            : null;
    }

    public async Task SaveAsync(string json, CancellationToken cancellationToken = default)
    {
        var directory = Path.GetDirectoryName(SettingsPath)!;
        Directory.CreateDirectory(directory);
        var temporaryPath = SettingsPath + ".tmp";
        await File.WriteAllTextAsync(temporaryPath, json, cancellationToken);
        File.Move(temporaryPath, SettingsPath, overwrite: true);
    }
}
