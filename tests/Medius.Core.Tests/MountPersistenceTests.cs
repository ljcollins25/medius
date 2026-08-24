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

    [Fact]
    public async Task PersistsPlaylistRangeAndProjectsOfflineFiles()
    {
        var mount = new MountDefinition
        {
            Id = "mount-1",
            Name = "Archive",
            ProviderKind = "Azure Blob",
            Endpoint = "https://archive.example.test/media?sig=test"
        };
        var playlist = new Playlist { Id = "playlist-1", Name = "Clips" };
        var store = new TestMountStore
        {
            Json = AppStateSerializer.ToJson(new AppState
            {
                Mounts = [mount],
                Playlists = [AppState.CreateHistoryPlaylist(), playlist],
                OfflineMedia =
                [
                    new OfflineMediaMetadata
                    {
                        MountId = mount.Id,
                        Path = "movies/offline.mp4",
                        SizeBytes = 1024,
                        LocalFileName = "offline.mp4"
                    }
                ]
            })
        };
        PlatformServices.Mounts = store;
        var viewModel = new MainViewModel();
        await WaitForAsync(() => viewModel.Playlists.Count == 2);
        viewModel.SelectedPlaylist = viewModel.Playlists.Single(item => item.Id == playlist.Id);
        viewModel.SelectedItem = new MediaItem(
            "movies/clip.mp4",
            "clip.mp4",
            false,
            Metadata: new Dictionary<string, string> { ["medius.mountId"] = mount.Id });
        viewModel.PlaylistStartSeconds = 12.5;
        viewModel.PlaylistEndSeconds = 42;

        await viewModel.AddSelectedToPlaylistCommand.ExecuteAsync(null);

        var persisted = AppStateSerializer.FromJson(store.Json!);
        var entry = Assert.Single(persisted.Playlists.Single(item => item.Id == playlist.Id).Entries);
        Assert.Equal(12.5, entry.StartSeconds);
        Assert.Equal(42, entry.EndSeconds);

        viewModel.ShowOfflineCommand.Execute(null);
        Assert.Equal("Offline", viewModel.CurrentLocation);
        Assert.Equal("offline.mp4", Assert.Single(viewModel.Items).Name);
    }

    [Fact]
    public async Task PlaysOfflinePlaylistRangeAndRecordsHistory()
    {
        var mount = new MountDefinition
        {
            Id = "mount-1",
            Name = "Archive",
            ProviderKind = "Azure Blob",
            Endpoint = "https://archive.example.test/media?sig=test"
        };
        var store = new TestMountStore
        {
            Json = AppStateSerializer.ToJson(new AppState
            {
                Mounts = [mount],
                Playlists =
                [
                    AppState.CreateHistoryPlaylist(),
                    new Playlist
                    {
                        Id = "clips",
                        Name = "Clips",
                        Entries =
                        [
                            new PlaylistEntry
                            {
                                MountId = mount.Id,
                                Path = "movies/clip.mp4",
                                Name = "clip.mp4",
                                StartSeconds = 12.5,
                                EndSeconds = 42
                            }
                        ]
                    }
                ],
                OfflineMedia =
                [
                    new OfflineMediaMetadata
                    {
                        MountId = mount.Id,
                        Path = "movies/clip.mp4",
                        SizeBytes = 1024
                    }
                ]
            })
        };
        var playback = new TestPlaybackHost();
        PlatformServices.Mounts = store;
        PlatformServices.Offline = new TestOfflineStore();
        PlatformServices.Playback = playback;
        var viewModel = new MainViewModel();
        await WaitForAsync(() => viewModel.Playlists.Count == 2);
        viewModel.SelectedItem = new MediaItem(
            "movies/clip.mp4",
            "clip.mp4",
            false,
            1024,
            Metadata: new Dictionary<string, string>
            {
                ["medius.kind"] = "playlistItem",
                ["medius.mountId"] = mount.Id,
                ["medius.startSeconds"] = "12.5",
                ["medius.endSeconds"] = "42"
            });

        await viewModel.PlayCommand.ExecuteAsync(null);

        Assert.Equal(12.5, playback.StartSeconds);
        Assert.Equal(42, playback.EndSeconds);
        var persisted = AppStateSerializer.FromJson(store.Json!);
        var history = persisted.Playlists.Single(item => item.Kind == PlaylistKind.History);
        Assert.Equal("movies/clip.mp4", Assert.Single(history.Entries).Path);
    }

    [Fact]
    public async Task RemovesOfflineEntryAndPinsPlaylist()
    {
        var mount = new MountDefinition
        {
            Id = "mount-1",
            Name = "Archive",
            ProviderKind = "Azure Blob",
            Endpoint = "https://archive.example.test/media?sig=test"
        };
        var playlist = new Playlist
        {
            Id = "playlist-1",
            Name = "Downloads",
            Entries =
            [
                new PlaylistEntry
                {
                    MountId = mount.Id,
                    Path = "movies/offline.mp4",
                    Name = "offline.mp4"
                }
            ]
        };
        var store = new TestMountStore
        {
            Json = AppStateSerializer.ToJson(new AppState
            {
                Mounts = [mount],
                Playlists = [AppState.CreateHistoryPlaylist(), playlist],
                OfflineMedia =
                [
                    new OfflineMediaMetadata
                    {
                        MountId = mount.Id,
                        Path = "movies/offline.mp4",
                        SizeBytes = 1024
                    }
                ]
            })
        };
        var offline = new TestOfflineStore();
        PlatformServices.Mounts = store;
        PlatformServices.Offline = offline;
        var viewModel = new MainViewModel();
        await WaitForAsync(() => viewModel.Playlists.Count == 2);
        viewModel.SelectedPlaylist = viewModel.Playlists.Single(item => item.Id == playlist.Id);

        await viewModel.TogglePlaylistOfflineCommand.ExecuteAsync(null);

        Assert.True(viewModel.SelectedPlaylist.KeepOffline);
        viewModel.ShowOfflineCommand.Execute(null);
        viewModel.SelectedItem = Assert.Single(viewModel.Items);
        await viewModel.RemoveSelectedOfflineCommand.ExecuteAsync(null);
        Assert.Empty(viewModel.OfflineFiles);
        Assert.NotNull(offline.LastRemovedKey);
    }

    [Fact]
    public async Task ImportsEncryptedStateWithoutAnExistingMount()
    {
        var importedMount = new MountDefinition
        {
            Id = "imported-mount",
            Name = "Imported",
            ProviderKind = "Azure Blob",
            Endpoint = "https://imported.example.test/media?sig=test"
        };
        var portable = new TestPortableAppDataHost
        {
            ImportedContent = AppStateSerializer.ToJson(new AppState
            {
                Mounts = [importedMount],
                Playlists = [AppState.CreateHistoryPlaylist()]
            })
        };
        PlatformServices.Mounts = new TestMountStore();
        PlatformServices.PortableAppData = portable;
        PlatformServices.StateProtector = new PassthroughStateProtector();
        var viewModel = new MainViewModel();
        await WaitForAsync(() => viewModel.Status != "Loading mounts…");

        await viewModel.ImportAppDataCommand.ExecuteAsync(null);

        Assert.Contains("File selected", viewModel.Status);
        Assert.Equal(1, portable.ImportCount);

        viewModel.AppDataPassphrase = "test-passphrase";
        await viewModel.ImportAppDataCommand.ExecuteAsync(null);

        Assert.Equal(1, portable.ImportCount);
        Assert.Equal(importedMount, Assert.Single(viewModel.Mounts));
        Assert.Equal("Encrypted app data imported and merged.", viewModel.Status);
    }

    [Fact]
    public async Task FailedImportAllowsChoosingAnotherFile()
    {
        var portable = new TestPortableAppDataHost { ImportedContent = "invalid" };
        PlatformServices.Mounts = new TestMountStore();
        PlatformServices.PortableAppData = portable;
        PlatformServices.StateProtector = new FailingStateProtector();
        var viewModel = new MainViewModel { AppDataPassphrase = "wrong-passphrase" };
        await WaitForAsync(() => viewModel.Status != "Loading mounts…");

        await viewModel.ImportAppDataCommand.ExecuteAsync(null);
        await viewModel.ImportAppDataCommand.ExecuteAsync(null);

        Assert.Equal(2, portable.ImportCount);
        Assert.Contains("Select the encrypted file again", viewModel.Status);
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

    private sealed class TestOfflineStore : IOfflineMediaStore
        {
            public string? LastRemovedKey { get; private set; }

            public Task CacheAsync(
                string key,
                Uri source,
                string? bearerToken = null,
                CancellationToken cancellationToken = default) =>
                Task.CompletedTask;

            public Task<Uri?> ResolveAsync(string key, CancellationToken cancellationToken = default) =>
                Task.FromResult<Uri?>(new Uri("https://offline.test/clip.mp4"));

            public Task<bool> RemoveAsync(string key, CancellationToken cancellationToken = default)
            {
                LastRemovedKey = key;
                return Task.FromResult(true);
            }

            public Task<OfflineStorageEstimate> EstimateAsync(CancellationToken cancellationToken = default) =>
                Task.FromResult(new OfflineStorageEstimate(1024, 1024 * 1024));
        }

    private sealed class TestPlaybackHost : IPlaybackHost
        {
            public double? StartSeconds { get; private set; }

            public double? EndSeconds { get; private set; }

            public Task StopAndShowLoadingAsync(string fileName, CancellationToken cancellationToken = default) =>
                Task.CompletedTask;

            public Task PlayAsync(
                PlaybackPlan plan,
                string? subtitleWebVtt,
                double embeddedSubtitleOffsetMilliseconds,
                double? startSeconds = null,
                double? endSeconds = null,
                string? mediaKey = null,
                int maxWidth = 854,
                long convertedCacheLimitBytes = 536870912,
                CancellationToken cancellationToken = default)
            {
                StartSeconds = startSeconds;
                EndSeconds = endSeconds;
                return Task.CompletedTask;
            }

            public Task SetSubtitleAsync(string? subtitleWebVtt, CancellationToken cancellationToken = default) =>
                Task.CompletedTask;

            public Task SetSubtitleStyleAsync(
                double fontSizePercent,
                double backgroundOpacity,
                CancellationToken cancellationToken = default) =>
                Task.CompletedTask;

            public Task<LocalSubtitle?> PickSubtitleAsync(CancellationToken cancellationToken = default) =>
                Task.FromResult<LocalSubtitle?>(null);

            public Task ClearConvertedCacheAsync(CancellationToken cancellationToken = default) =>
                Task.CompletedTask;

            public Task<long> GetConvertedCacheUsageAsync(CancellationToken cancellationToken = default) =>
                Task.FromResult(0L);
    }

    private sealed class TestPortableAppDataHost : IPortableAppDataHost
    {
        public required string ImportedContent { get; init; }

        public int ImportCount { get; private set; }

        public Task ExportFileAsync(string fileName, string content) => Task.CompletedTask;

        public Task<string?> ImportFileAsync()
        {
            ImportCount++;
            return Task.FromResult<string?>(ImportedContent);
        }

        public Task ShowQrAsync(string payload) => Task.CompletedTask;

        public Task<string?> ScanQrCameraAsync() => Task.FromResult<string?>(null);

        public Task<string?> ScanQrFileAsync() => Task.FromResult<string?>(null);
    }

    private sealed class PassthroughStateProtector : IAppStateProtector
    {
        public Task<string> EncryptAsync(string plaintextJson, string passphrase) =>
            Task.FromResult(plaintextJson);

        public Task<string> DecryptAsync(string envelopeJson, string passphrase) =>
            Task.FromResult(envelopeJson);
    }

    private sealed class FailingStateProtector : IAppStateProtector
    {
        public Task<string> EncryptAsync(string plaintextJson, string passphrase) =>
            throw new InvalidOperationException("Not used.");

        public Task<string> DecryptAsync(string envelopeJson, string passphrase) =>
            throw new InvalidDataException("Invalid encrypted file.");
    }
}
