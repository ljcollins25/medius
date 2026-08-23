using System;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Medius.Services;

namespace Medius.Desktop;

internal sealed class DesktopOfflineMediaStore : IOfflineMediaStore
{
    private static readonly HttpClient HttpClient = new();
    private static readonly string CacheDirectory = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "Medius",
        "offline");

    public async Task CacheAsync(
        string key,
        Uri source,
        string? bearerToken = null,
        CancellationToken cancellationToken = default)
    {
        Directory.CreateDirectory(CacheDirectory);
        var target = GetPath(key);
        var temporary = target + ".tmp";
        using var request = new HttpRequestMessage(HttpMethod.Get, source);
        if (!string.IsNullOrWhiteSpace(bearerToken))
        {
            request.Headers.Authorization =
                new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", bearerToken);
        }
        using var response = await HttpClient.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
        response.EnsureSuccessStatusCode();
        await using var input = await response.Content.ReadAsStreamAsync(cancellationToken);
        await using (var output = File.Create(temporary))
        {
            await input.CopyToAsync(output, cancellationToken);
        }
        File.Move(temporary, target, overwrite: true);
    }

    public Task<Uri?> ResolveAsync(string key, CancellationToken cancellationToken = default)
    {
        var path = GetPath(key);
        return Task.FromResult(File.Exists(path) ? new Uri(path) : null);
    }

    public Task<bool> RemoveAsync(string key, CancellationToken cancellationToken = default)
    {
        var path = GetPath(key);
        if (!File.Exists(path)) return Task.FromResult(false);
        File.Delete(path);
        return Task.FromResult(true);
    }

    public Task<OfflineStorageEstimate> EstimateAsync(CancellationToken cancellationToken = default)
    {
        var usage = Directory.Exists(CacheDirectory)
            ? Directory.EnumerateFiles(CacheDirectory).Sum(path => new FileInfo(path).Length)
            : 0;
        var root = Path.GetPathRoot(CacheDirectory)!;
        var quota = new DriveInfo(root).AvailableFreeSpace;
        return Task.FromResult(new OfflineStorageEstimate(usage, quota));
    }

    private static string GetPath(string key)
    {
        var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(key)));
        var extension = Path.GetExtension(key);
        return Path.Combine(CacheDirectory, hash + extension);
    }
}
