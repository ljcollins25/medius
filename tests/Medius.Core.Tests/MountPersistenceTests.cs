using System.Text.Json;
using Medius.Services;
using Medius.ViewModels;

namespace Medius.Core.Tests;

public sealed class MountPersistenceTests
{
    [Fact]
    public void TogglesSubtitleSettingsMenu()
    {
        var viewModel = new MainViewModel();

        viewModel.ToggleSubtitleMenuCommand.Execute(null);
        Assert.True(viewModel.IsSubtitleMenuOpen);

        viewModel.ToggleSubtitleMenuCommand.Execute(null);
        Assert.False(viewModel.IsSubtitleMenuOpen);
    }

    [Fact]
    public async Task SavesAndRestoresMultipleNamedMounts()
    {
        var store = new TestMountStore();
        PlatformServices.Mounts = store;
        var viewModel = new MainViewModel();
        await WaitForAsync(() => viewModel.Status != "Loading mounts…");

        await AddMountAsync(viewModel, "WUS", "https://wus.example.test/media?sig=test");
        await AddMountAsync(viewModel, "Archive", "https://archive.example.test/media?sig=test");

        Assert.Equal(["Archive", "WUS"], viewModel.Items.Select(item => item.Name));
        Assert.NotNull(store.Json);

        PlatformServices.Mounts = store;
        var restored = new MainViewModel();
        await WaitForAsync(() => restored.Mounts.Count == 2);

        Assert.Equal(["Archive", "WUS"], restored.Items.Select(item => item.Name));
    }

    [Fact]
    public async Task ShowsLiveWusGhostLogicalSizesWhenConfigured()
    {
        var sasUrl = Environment.GetEnvironmentVariable("MEDIUS_TEST_AZURE_BLOB_SAS");
        if (string.IsNullOrWhiteSpace(sasUrl))
        {
            return;
        }

        var store = new TestMountStore
        {
            Json = JsonSerializer.Serialize(new[]
            {
                new MountDefinition
                {
                    Name = "WUS test fixtures",
                    ProviderKind = "Azure Blob",
                    Endpoint = sasUrl
                }
            })
        };
        PlatformServices.Mounts = store;
        var viewModel = new MainViewModel();
        await WaitForAsync(() => viewModel.Items.Count == 1);
        viewModel.SelectedItem = viewModel.Items.Single();

        await viewModel.OpenCommand.ExecuteAsync(null);

        Assert.Equal("WUS test fixtures", viewModel.CurrentLocation);
        Assert.Equal(186_763_133, viewModel.Items.Single(item => item.Name == "medius-wus-test.mp4").Size);
        Assert.Equal(170_670_452, viewModel.Items.Single(item => item.Name == "medius-wus-test.avi").Size);
    }

    [Fact]
    public async Task DoesNotAddMountWhenPersistenceFails()
    {
        var store = new TestMountStore { FailSave = true };
        PlatformServices.Mounts = store;
        var viewModel = new MainViewModel();
        await WaitForAsync(() => viewModel.Status != "Loading mounts…");

        await AddMountAsync(viewModel, "Unavailable", "https://example.test/media?sig=test");

        Assert.Empty(viewModel.Mounts);
        Assert.Contains("failed", viewModel.Status, StringComparison.OrdinalIgnoreCase);
    }

    private static async Task AddMountAsync(MainViewModel viewModel, string name, string endpoint)
    {
        viewModel.ShowAddMountCommand.Execute(null);
        viewModel.MountName = name;
        viewModel.ProviderKind = "Azure Blob";
        viewModel.Endpoint = endpoint;
        await viewModel.SaveMountCommand.ExecuteAsync(null);
    }

    private static async Task WaitForAsync(Func<bool> condition)
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        while (!condition())
        {
            await Task.Delay(10, timeout.Token);
        }
    }

    private sealed class TestMountStore : IMountStore
    {
        public string? Json { get; set; }

        public bool FailSave { get; init; }

        public Task<string?> LoadAsync(CancellationToken cancellationToken = default) =>
            Task.FromResult(Json);

        public Task SaveAsync(string json, CancellationToken cancellationToken = default)
        {
            if (FailSave)
            {
                throw new IOException("Persistence failed.");
            }

            Json = json;
            return Task.CompletedTask;
        }
    }
}
