using Medius.Providers.Azure;

namespace Medius.Core.Tests;

public sealed class AzureBlobProviderTests
{
    [Fact]
    public void UsesNexisGhostTagContract()
    {
        Assert.Equal("ghostd_state", GhostBlobHydrator.StateTag);
        Assert.Equal("ghostd_size", GhostBlobHydrator.SizeTag);
        Assert.Equal("ghostd_block_prefix", GhostBlobHydrator.BlockPrefixTag);
    }

    [Fact]
    public async Task ListsLiveGhostLogicalSizesWhenConfigured()
    {
        var sasUrl = Environment.GetEnvironmentVariable("MEDIUS_TEST_AZURE_BLOB_SAS");
        if (string.IsNullOrWhiteSpace(sasUrl))
        {
            return;
        }

        var provider = new AzureBlobMediaProvider(new AzureBlobOptions
        {
            ContainerUri = new Uri(sasUrl)
        });
        var pending = new Queue<string>();
        pending.Enqueue(string.Empty);

        while (pending.TryDequeue(out var path))
        {
            var items = await provider.ListAsync(path);
            foreach (var directory in items.Where(item => item.IsDirectory))
            {
                pending.Enqueue(directory.Path);
            }

            var ghost = items.FirstOrDefault(item =>
                item.Metadata?.TryGetValue(GhostBlobHydrator.StateTag, out var state) == true
                && state.Equals("ghost", StringComparison.OrdinalIgnoreCase));
            if (ghost is not null)
            {
                Assert.True(ghost.Size > 0);
                return;
            }
        }

        Assert.Fail("The configured container did not contain a Nexis ghost blob.");
    }

    [Fact]
    public async Task HydratesAndReadsConfiguredLiveGhost()
    {
        var sasUrl = Environment.GetEnvironmentVariable("MEDIUS_TEST_AZURE_BLOB_SAS");
        var blobName = Environment.GetEnvironmentVariable("MEDIUS_TEST_AZURE_GHOST_NAME");
        if (string.IsNullOrWhiteSpace(sasUrl) || string.IsNullOrWhiteSpace(blobName))
        {
            return;
        }

        var provider = new AzureBlobMediaProvider(new AzureBlobOptions
        {
            ContainerUri = new Uri(sasUrl)
        });
        var item = Assert.Single(
            await provider.ListAsync(string.Empty),
            candidate => candidate.Name.Equals(blobName, StringComparison.OrdinalIgnoreCase));

        var content = await provider.GetContentAsync(item);
        await using var stream = await provider.OpenReadAsync(item);

        Assert.Equal(item.Size, content.Size);
        Assert.True(stream.ReadByte() >= 0);
    }

    [Fact]
    public void ImplementsWritableAppDataProviderForAppStateSync()
    {
        Assert.True(typeof(IWritableAppDataProvider).IsAssignableFrom(typeof(AzureBlobMediaProvider)));
        Assert.True(typeof(IWritableAppDataProvider).IsAssignableFrom(typeof(OneDriveMediaProvider)));
    }

    [Fact]
    public async Task RoundTripsAppDataTextWhenConfigured()
    {
        var sasUrl = Environment.GetEnvironmentVariable("MEDIUS_TEST_AZURE_BLOB_SAS");
        if (string.IsNullOrWhiteSpace(sasUrl))
        {
            return;
        }

        IWritableAppDataProvider provider = new AzureBlobMediaProvider(new AzureBlobOptions
        {
            ContainerUri = new Uri(sasUrl),
        });

        var path = $"medius-test/app-state-{Guid.NewGuid():N}.json.enc";
        var missing = await provider.ReadTextAsync(path);
        Assert.Null(missing);

        var content = $$"""{"probe":"{{Guid.NewGuid()}}"}""";
        await provider.WriteTextAsync(path, content);

        var roundTripped = await provider.ReadTextAsync(path);
        Assert.Equal(content, roundTripped);
    }
}
