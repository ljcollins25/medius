using System.Collections.ObjectModel;
using System.Text;
using System.Text.Json;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Medius.Core;
using Medius.Providers.Azure;
using Medius.Services;

namespace Medius.ViewModels;

public sealed record ConversionResolutionOption(string Name, int Width);

public partial class MainViewModel : ViewModelBase
{
    private const string MountIdKey = "medius.mountId";
    private const string EntryKindKey = "medius.kind";
    private const string PlaylistIdKey = "medius.playlistId";
    private const string StartSecondsKey = "medius.startSeconds";
    private const string EndSecondsKey = "medius.endSeconds";
    private IMediaProvider? _provider;
    private MountDefinition? _activeMount;
    private AppState _appState = new();
    private LocalSubtitle? _localSubtitle;
    private MediaItem? _playingVideo;
    private Playlist? _currentPlaylist;
    private string? _pendingImportedAppDataEnvelope;
    private int _playbackRequestId;
    private int _subtitleRequestId;

    public MainViewModel()
    {
        ProviderKinds = ["Azure Blob", "Azure Files", "OneDrive"];
        ConversionResolutions =
        [
            new("Original", 0),
            new("1080p", 1920),
            new("720p", 1280),
            new("480p", 854)
        ];
        SelectedConversionResolution = ConversionResolutions[^1];
        _ = InitializeAsync();
    }

    public IReadOnlyList<string> ProviderKinds { get; }

    public IReadOnlyList<ConversionResolutionOption> ConversionResolutions { get; }

    public bool SupportsPortableAppData => OperatingSystem.IsBrowser();

    public ObservableCollection<MountDefinition> Mounts { get; } = [];

    public ObservableCollection<Playlist> Playlists { get; } = [];

    public ObservableCollection<OfflineMediaMetadata> OfflineFiles { get; } = [];

    public ObservableCollection<MediaItem> Items { get; } = [];

    [ObservableProperty]
    public partial string MountName { get; set; } = string.Empty;

    [ObservableProperty]
    public partial string ProviderKind { get; set; } = "Azure Blob";

    [ObservableProperty]
    public partial string Endpoint { get; set; } = string.Empty;

    [ObservableProperty]
    public partial string AccountName { get; set; } = string.Empty;

    [ObservableProperty]
    public partial string Credential { get; set; } = string.Empty;

    [ObservableProperty]
    public partial string RootPath { get; set; } = string.Empty;

    [ObservableProperty]
    public partial string TenantId { get; set; } = "common";

    [ObservableProperty]
    public partial string ClientId { get; set; } = string.Empty;

    [ObservableProperty]
    public partial bool IsMountEditorVisible { get; set; }

    [ObservableProperty]
    public partial bool IsSubtitleMenuOpen { get; set; }

    [ObservableProperty]
    public partial bool IsPlaylistPanelVisible { get; set; }

    [ObservableProperty]
    public partial bool IsAppDataPanelVisible { get; set; }

    [ObservableProperty]
    public partial bool IsConversionQueueVisible { get; set; }

    [ObservableProperty]
    public partial bool IsOfflineView { get; set; }

    [ObservableProperty]
    public partial bool IsPlaylistView { get; set; }

    [ObservableProperty]
    public partial string NewPlaylistName { get; set; } = string.Empty;

    [ObservableProperty]
    public partial Playlist? SelectedPlaylist { get; set; }

    [ObservableProperty]
    public partial double? PlaylistStartSeconds { get; set; }

    [ObservableProperty]
    public partial double? PlaylistEndSeconds { get; set; }

    [ObservableProperty]
    public partial MountDefinition? AppDataMount { get; set; }

    [ObservableProperty]
    public partial string AppDataPath { get; set; } = ".medius-app-state.json.enc";

    [ObservableProperty]
    public partial string AppDataPassphrase { get; set; } = string.Empty;

    [ObservableProperty]
    public partial string OfflineStorageLabel { get; set; } = "Offline storage";

    [ObservableProperty]
    public partial ConversionResolutionOption? SelectedConversionResolution { get; set; }

    [ObservableProperty]
    public partial double ConvertedCacheSizeMb { get; set; } = 512;

    [ObservableProperty]
    public partial string ConvertedCacheLabel { get; set; } = "Converted cache";

    [ObservableProperty]
    public partial string CurrentPath { get; set; } = string.Empty;

    [ObservableProperty]
    public partial string CurrentLocation { get; set; } = "Mounts";

    [ObservableProperty]
    public partial MediaItem? SelectedItem { get; set; }

    [ObservableProperty]
    public partial MediaItem? SelectedSubtitle { get; set; }

    [ObservableProperty]
    public partial double SubtitleOffsetMilliseconds { get; set; }

    [ObservableProperty]
    public partial double SubtitleFontSizePercent { get; set; } = 100;

    [ObservableProperty]
    public partial double SubtitleBackgroundOpacityPercent { get; set; } = 72;

    [ObservableProperty]
    public partial string SelectedSubtitleLabel { get; set; } = "Auto-detect adjacent or embedded subtitles";

    [ObservableProperty]
    public partial string Status { get; set; } = "Loading mounts…";

    [ObservableProperty]
    public partial bool IsBusy { get; set; }

    [RelayCommand]
    private void ShowAddMount()
    {
        IsAppDataPanelVisible = false;
        IsConversionQueueVisible = false;
        MountName = string.Empty;
        ProviderKind = "Azure Blob";
        Endpoint = string.Empty;
        AccountName = string.Empty;
        Credential = string.Empty;
        RootPath = string.Empty;
        TenantId = "common";
        ClientId = string.Empty;
        IsMountEditorVisible = true;
        Status = "Configure a named storage mount.";
    }

    [RelayCommand]
    private void CancelMount() => IsMountEditorVisible = false;

    [RelayCommand]
    private void ToggleSubtitleMenu() => IsSubtitleMenuOpen = !IsSubtitleMenuOpen;

    [RelayCommand]
    private void TogglePlaylistPanel() => IsPlaylistPanelVisible = !IsPlaylistPanelVisible;

    [RelayCommand]
    private void ToggleAppDataPanel()
    {
        IsMountEditorVisible = false;
        IsConversionQueueVisible = false;
        IsAppDataPanelVisible = !IsAppDataPanelVisible;
    }

    [RelayCommand]
    private void ToggleConversionQueue()
    {
        IsMountEditorVisible = false;
        IsAppDataPanelVisible = false;
        IsConversionQueueVisible = !IsConversionQueueVisible;
    }

    [RelayCommand]
    private async Task SaveAppDataSettingsAsync()
    {
        if (AppDataMount is null)
        {
            Status = "Choose the mount that will store app data.";
            return;
        }

        if (string.IsNullOrWhiteSpace(AppDataPassphrase))
        {
            Status = "Enter the encryption passphrase.";
            return;
        }
        try
        {
            await SaveStateAsync(sync: false);
            await PushAppDataAsync(saveLocalFirst: false);
            Status = $"Encrypted app data saved to {AppDataMount.Name}.";
        }
        catch (Exception exception)
        {
            Status = exception.Message;
        }
    }

    [RelayCommand]
    private async Task ExportAppDataAsync()
    {
        if (string.IsNullOrWhiteSpace(AppDataPassphrase))
        {
            Status = "Enter an export passphrase first.";
            return;
        }
        try
        {
            await SaveStateAsync(sync: false);
            var envelope = await PlatformServices.StateProtector.EncryptAsync(
                AppStateSerializer.ToJson(_appState),
                AppDataPassphrase);
            await PlatformServices.PortableAppData.ExportFileAsync(
                $"medius-app-state-{DateTime.UtcNow:yyyyMMdd-HHmmss}.json",
                envelope);
            Status = "Encrypted app data exported.";
        }
        catch (Exception exception)
        {
            Status = exception.Message;
        }
    }

    [RelayCommand]
    private async Task ImportAppDataAsync()
    {
        try
        {
            _pendingImportedAppDataEnvelope ??= await PlatformServices.PortableAppData.ImportFileAsync();
            if (string.IsNullOrWhiteSpace(_pendingImportedAppDataEnvelope))
            {
                return;
            }
            if (string.IsNullOrWhiteSpace(AppDataPassphrase))
            {
                Status = "File selected. Enter its passphrase, then tap Import encrypted file again.";
                return;
            }

            var plaintext = await PlatformServices.StateProtector.DecryptAsync(
                _pendingImportedAppDataEnvelope,
                AppDataPassphrase);
            await ApplyMergedStateAsync(AppStateSerializer.FromJson(plaintext));
            _pendingImportedAppDataEnvelope = null;
            Status = "Encrypted app data imported and merged.";
        }
        catch (Exception exception)
        {
            _pendingImportedAppDataEnvelope = null;
            Status = $"{exception.Message} Select the encrypted file again.";
        }
    }

    [RelayCommand]
    private async Task ShowSyncQrAsync()
    {
        if (AppDataMount is null || string.IsNullOrWhiteSpace(AppDataPassphrase))
        {
            Status = "Choose the app-data mount and enter its passphrase first.";
            return;
        }
        try
        {
            var payload = new SyncBootstrap
            {
                Mount = AppDataMount,
                BlobPath = AppDataPath.Trim('/'),
                Passphrase = AppDataPassphrase
            };
            var json = JsonSerializer.Serialize(payload, AppStateJsonContext.Default.SyncBootstrap);
            await PlatformServices.PortableAppData.ShowQrAsync(json);
            Status = "QR shown. It contains the credential and passphrase.";
        }
        catch (Exception exception)
        {
            Status = $"Could not create sync QR: {exception.Message} Use encrypted file export instead.";
        }
    }

    [RelayCommand]
    private async Task ScanSyncQrCameraAsync()
    {
        try
        {
            await ApplySyncBootstrapAsync(await PlatformServices.PortableAppData.ScanQrCameraAsync());
        }
        catch (Exception exception)
        {
            Status = exception.Message;
        }
    }

    [RelayCommand]
    private async Task ScanSyncQrFileAsync()
    {
        try
        {
            await ApplySyncBootstrapAsync(await PlatformServices.PortableAppData.ScanQrFileAsync());
        }
        catch (Exception exception)
        {
            Status = exception.Message;
        }
    }

    [RelayCommand]
    private async Task PullAppDataAsync()
    {
        if (AppDataMount is null || string.IsNullOrWhiteSpace(AppDataPassphrase))
        {
            Status = "Choose the app-data mount and enter its passphrase.";
            return;
        }

        try
        {
            var provider = CreateProvider(AppDataMount) as IWritableAppDataProvider
                ?? throw new InvalidOperationException("The selected provider cannot store app data.");
            var envelope = await provider.ReadTextAsync(AppDataPath.Trim('/'));
            if (string.IsNullOrWhiteSpace(envelope))
            {
                Status = "No synchronized app data exists at that path.";
                return;
            }

            var plaintext = await PlatformServices.StateProtector.DecryptAsync(envelope, AppDataPassphrase);
            var synced = AppStateSerializer.FromJson(plaintext);
            await ApplyMergedStateAsync(synced);
            Status = "Encrypted app data downloaded and merged.";
        }
        catch (Exception exception)
        {
            Status = exception.Message;
        }
    }

    private async Task PushAppDataAsync(bool saveLocalFirst)
    {
        if (AppDataMount is null || string.IsNullOrWhiteSpace(AppDataPassphrase)) return;
        if (saveLocalFirst) await SaveStateAsync(sync: false);

        var provider = CreateProvider(AppDataMount) as IWritableAppDataProvider
            ?? throw new InvalidOperationException("The selected provider cannot store app data.");
        var cloudMounts = _appState.Mounts
            .Select(item => item.Id == AppDataMount.Id
                ? item with
                {
                    Credential = string.Empty,
                    Endpoint = RemoveQuery(item.Endpoint)
                }
                : item)
            .ToList();
        var cloudState = _appState with { Mounts = cloudMounts };
        var plaintext = AppStateSerializer.ToJson(cloudState);
        var envelope = await PlatformServices.StateProtector.EncryptAsync(plaintext, AppDataPassphrase);
        await provider.WriteTextAsync(AppDataPath.Trim('/'), envelope);
    }

    private async Task ApplySyncBootstrapAsync(string? payloadJson)
    {
        if (string.IsNullOrWhiteSpace(payloadJson)) return;
        var payload = JsonSerializer.Deserialize(
            payloadJson,
            AppStateJsonContext.Default.SyncBootstrap)
            ?? throw new InvalidDataException("The QR code does not contain Medius sync data.");
        if (payload.Version != 1)
        {
            throw new NotSupportedException($"Unsupported sync QR version {payload.Version}.");
        }

        var existing = Mounts.FirstOrDefault(item => item.Id == payload.Mount.Id);
        if (existing is null)
        {
            Mounts.Add(payload.Mount);
            AppDataMount = payload.Mount;
        }
        else
        {
            var index = Mounts.IndexOf(existing);
            Mounts[index] = payload.Mount;
            AppDataMount = payload.Mount;
        }
        AppDataPath = payload.BlobPath;
        AppDataPassphrase = payload.Passphrase;
        await SaveStateAsync(sync: false);
        await PullAppDataAsync();
    }

    private async Task ApplyMergedStateAsync(AppState synced)
    {
        var localAppDataMountId = AppDataMount?.Id;
        var localAppDataPath = AppDataPath;
        var localMounts = Mounts.ToDictionary(item => item.Id);
        var mergedMounts = synced.Mounts
            .Select(item => localMounts.TryGetValue(item.Id, out var local)
                ? item with
                {
                    Credential = string.IsNullOrWhiteSpace(local.Credential)
                        ? item.Credential
                        : local.Credential,
                    Endpoint = local.Endpoint.Contains('?')
                        ? local.Endpoint
                        : item.Endpoint
                }
                : item)
            .Concat(Mounts.Where(local => synced.Mounts.All(remote => remote.Id != local.Id)))
            .ToList();
        var mergedPlaylists = MergePlaylists(synced.Playlists, Playlists);
        var mergedOffline = synced.OfflineMedia
            .Concat(OfflineFiles)
            .GroupBy(item => (item.MountId, item.Path))
            .Select(group => group.OrderByDescending(item => item.DownloadedAt).First())
            .ToList();

        Mounts.Clear();
        Playlists.Clear();
        OfflineFiles.Clear();
        foreach (var mount in mergedMounts) Mounts.Add(mount);
        foreach (var playlist in mergedPlaylists) Playlists.Add(playlist);
        if (!Playlists.Any(item => item.Kind == PlaylistKind.History))
        {
            Playlists.Add(AppState.CreateHistoryPlaylist());
        }
        foreach (var offline in mergedOffline) OfflineFiles.Add(offline);
        SelectedPlaylist = Playlists.FirstOrDefault(item => !item.IsAutomatic);
        AppDataMount = Mounts.FirstOrDefault(item => item.Id == localAppDataMountId);
        if (AppDataMount is not null)
        {
            AppDataPath = localAppDataPath;
        }
        else
        {
            AppDataMount = Mounts.FirstOrDefault(item => item.Id == synced.AppDataSync.BootstrapMountId);
            if (!string.IsNullOrWhiteSpace(synced.AppDataSync.BlobPath))
            {
                AppDataPath = synced.AppDataSync.BlobPath;
            }
        }
        await SaveStateAsync(sync: false);
        ShowMountRoot();
    }

    [RelayCommand]
    private void ShowOffline()
    {
        _provider = null;
        _activeMount = null;
        _currentPlaylist = null;
        IsOfflineView = true;
        IsPlaylistView = false;
        CurrentLocation = "Offline";
        Items.Clear();
        foreach (var entry in OfflineFiles.OrderBy(item => Path.GetFileName(item.Path), StringComparer.OrdinalIgnoreCase))
        {
            Items.Add(CreateVirtualMediaItem(
                "offline",
                entry.MountId,
                entry.Path,
                Path.GetFileName(entry.Path),
                entry.SizeBytes));
        }
        SelectedItem = null;
        Status = $"{OfflineFiles.Count} offline file{(OfflineFiles.Count == 1 ? string.Empty : "s")}.";
        _ = RefreshOfflineStorageAsync();
    }

    [RelayCommand]
    private void ShowPlaylists()
    {
        _provider = null;
        _activeMount = null;
        _currentPlaylist = null;
        IsOfflineView = false;
        IsPlaylistView = true;
        CurrentLocation = "Playlists";
        Items.Clear();
        foreach (var playlist in Playlists.OrderBy(item => item.IsAutomatic ? 0 : 1).ThenBy(item => item.Name))
        {
            Items.Add(new MediaItem(
                playlist.Id,
                playlist.Name,
                true,
                Metadata: new Dictionary<string, string>
                {
                    [EntryKindKey] = "playlist",
                    [PlaylistIdKey] = playlist.Id
                }));
        }
        SelectedItem = null;
        Status = $"{Playlists.Count} playlist{(Playlists.Count == 1 ? string.Empty : "s")}.";
    }

    [RelayCommand]
    private void ShowHistory()
    {
        var history = EnsureHistoryPlaylist();
        ShowPlaylist(history);
    }

    [RelayCommand]
    private void ShowMounts() => ShowMountRoot();

    [RelayCommand]
    private async Task CreatePlaylistAsync()
    {
        var name = NewPlaylistName.Trim();
        if (name.Length == 0)
        {
            Status = "Enter a playlist name.";
            return;
        }
        if (Playlists.Any(item => item.Name.Equals(name, StringComparison.OrdinalIgnoreCase)))
        {
            Status = $"A playlist named '{name}' already exists.";
            return;
        }

        var playlist = new Playlist { Name = name };
        Playlists.Add(playlist);
        SelectedPlaylist = playlist;
        NewPlaylistName = string.Empty;
        await SaveStateAsync();
        ShowPlaylist(playlist);
    }

    [RelayCommand]
    private async Task AddSelectedToPlaylistAsync()
    {
        if (SelectedPlaylist is null || SelectedItem is null || !MediaTypes.IsVideo(SelectedItem))
        {
            Status = "Select a video and playlist first.";
            return;
        }

        var mountId = GetItemMountId(SelectedItem);
        if (mountId is null)
        {
            Status = "The selected video is not associated with a mount.";
            return;
        }
        if (PlaylistEndSeconds is not null
            && PlaylistStartSeconds is not null
            && PlaylistEndSeconds <= PlaylistStartSeconds)
        {
            Status = "Playlist end time must be after its start time.";
            return;
        }

        SelectedPlaylist.Entries.Add(new PlaylistEntry
        {
            MountId = mountId,
            Path = SelectedItem.Path,
            Name = SelectedItem.Name,
            StartSeconds = PlaylistStartSeconds,
            EndSeconds = PlaylistEndSeconds,
            AddedAt = DateTimeOffset.UtcNow
        });
        await SaveStateAsync();
        if (SelectedPlaylist.KeepOffline)
        {
            await CachePlaylistEntryAsync(SelectedPlaylist.Entries[^1]);
        }
        Status = $"Added {SelectedItem.Name} to {SelectedPlaylist.Name}.";
    }

    [RelayCommand]
    private async Task TogglePlaylistOfflineAsync()
    {
        if (SelectedPlaylist is null)
        {
            Status = "Select a playlist first.";
            return;
        }

        try
        {
            var index = Playlists.IndexOf(SelectedPlaylist);
            var updated = SelectedPlaylist with { KeepOffline = !SelectedPlaylist.KeepOffline };
            Playlists[index] = updated;
            SelectedPlaylist = updated;
            await SaveStateAsync();
            if (updated.KeepOffline)
            {
                foreach (var entry in updated.Entries)
                {
                    await CachePlaylistEntryAsync(entry);
                }
            }
            Status = updated.KeepOffline
                ? $"{updated.Name} is available offline."
                : $"{updated.Name} is no longer pinned offline.";
        }
        catch (Exception exception)
        {
            Status = exception.Message;
        }
    }

    [RelayCommand]
    private async Task ClearCurrentPlaylistAsync()
    {
        if (_currentPlaylist is null)
        {
            Status = "Open a playlist first.";
            return;
        }
        _currentPlaylist.Entries.Clear();
        await SaveStateAsync();
        ShowPlaylist(_currentPlaylist);
        Status = $"Cleared {_currentPlaylist.Name}.";
    }

    [RelayCommand]
    private async Task DeleteSelectedPlaylistAsync()
    {
        if (SelectedPlaylist is null || SelectedPlaylist.IsAutomatic)
        {
            Status = "Automatic playlists can be cleared but not deleted.";
            return;
        }
        Playlists.Remove(SelectedPlaylist);
        _currentPlaylist = null;
        SelectedPlaylist = Playlists.FirstOrDefault(item => !item.IsAutomatic);
        await SaveStateAsync();
        ShowPlaylists();
    }

    [RelayCommand]
    private async Task RemoveSelectedPlaylistEntryAsync()
    {
        if (_currentPlaylist is null || SelectedItem is null) return;
        var entry = _currentPlaylist.Entries.FirstOrDefault(item =>
            item.MountId == GetItemMountId(SelectedItem) && item.Path == SelectedItem.Path);
        if (entry is null) return;
        _currentPlaylist.Entries.Remove(entry);
        await SaveStateAsync();
        ShowPlaylist(_currentPlaylist);
    }

    [RelayCommand]
    private async Task KeepSelectedOfflineAsync()
    {
        if (SelectedItem is null || !MediaTypes.IsVideo(SelectedItem))
        {
            Status = "Select a video first.";
            return;
        }
        try
        {
            await CacheMediaItemAsync(SelectedItem);
        }
        catch (Exception exception)
        {
            Status = exception.Message;
        }
    }

    [RelayCommand]
    private async Task QueueSelectedForConversionAsync()
    {
        if (SelectedItem is null || !MediaTypes.IsVideo(SelectedItem))
        {
            Status = "Select a video first.";
            return;
        }

        await RunUiOperationAsync(async () =>
        {
            var selected = SelectedItem ?? throw new InvalidOperationException("Select a video first.");
            var target = await ResolveSelectedVideoForPlaybackAsync(selected);
            Func<CancellationToken, Task<Uri>>? uriResolver = target.OfflineUri is null
                ? cancellationToken => ResolveFreshContentUriAsync(
                    target.Mount,
                    target.Video,
                    cancellationToken)
                : null;
            var jobId = await PlatformServices.BackgroundConversion.EnqueueConversionAsync(
                target.Content.Uri.ToString(),
                target.Video.Name,
                BuildMediaKey(target.Mount.Id, target.Video),
                SelectedConversionResolution?.Width ?? 854,
                (long)(Math.Max(0, ConvertedCacheSizeMb) * 1024 * 1024),
                target.Content.Size ?? target.Video.Size ?? 0,
                uriResolver);
            IsConversionQueueVisible = true;
            Status = $"Queued {target.Video.Name} for background conversion ({jobId}).";
        });
    }

    private async Task<Uri> ResolveFreshContentUriAsync(
        MountDefinition mount,
        MediaItem video,
        CancellationToken cancellationToken)
    {
        var provider = CreateProvider(mount);
        var siblings = await provider.ListAsync(GetParentPath(video.Path), cancellationToken);
        var refreshed = siblings.FirstOrDefault(item =>
            !item.IsDirectory
            && string.Equals(item.Path, video.Path, StringComparison.OrdinalIgnoreCase))
            ?? video;
        return (await provider.GetContentAsync(refreshed, cancellationToken)).Uri;
    }

    [RelayCommand]
    private async Task RemoveSelectedOfflineAsync()
    {
        if (SelectedItem is null) return;
        var mountId = GetItemMountId(SelectedItem);
        if (mountId is null) return;
        var key = GetOfflineKey(mountId, SelectedItem.Path);
        try
        {
            await PlatformServices.Offline.RemoveAsync(key);
            var metadata = OfflineFiles.FirstOrDefault(item => item.MountId == mountId && item.Path == SelectedItem.Path);
            if (metadata is not null) OfflineFiles.Remove(metadata);
            await SaveStateAsync();
            ShowOffline();
        }
        catch (Exception exception)
        {
            Status = exception.Message;
        }
    }

    [RelayCommand]
    private async Task SaveMountAsync()
    {
        await RunUiOperationAsync(async () =>
        {
            var name = Required(MountName, "mount name");
            if (Mounts.Any(mount => mount.Name.Equals(name, StringComparison.OrdinalIgnoreCase)))
            {
                throw new InvalidOperationException($"A mount named '{name}' already exists.");
            }

            var mount = new MountDefinition
            {
                Name = name,
                ProviderKind = ProviderKind,
                Endpoint = Endpoint.Trim(),
                AccountName = AccountName.Trim(),
                Credential = Credential.Trim(),
                RootPath = RootPath.Trim('/'),
                TenantId = string.IsNullOrWhiteSpace(TenantId) ? "common" : TenantId.Trim(),
                ClientId = ClientId.Trim()
            };

            _ = CreateProvider(mount);
            await SaveMountsAsync(Mounts.Append(mount));
            Mounts.Add(mount);
            IsMountEditorVisible = false;
            ShowMountRoot();
            Status = $"Mounted {mount.Name}.";
        });
    }

    [RelayCommand]
    private async Task RemoveMountAsync()
    {
        var mountId = _activeMount?.Id;
        if (mountId is null
            && CurrentLocation == "Mounts"
            && SelectedItem?.Metadata?.ContainsKey(EntryKindKey) != true
            && SelectedItem?.Metadata?.TryGetValue(MountIdKey, out var selectedMountId) == true)
        {
            mountId = selectedMountId;
        }

        var mount = Mounts.FirstOrDefault(candidate => candidate.Id == mountId);
        if (mount is null)
        {
            Status = "Select or open a mount to remove it.";
            return;
        }

        await RunUiOperationAsync(async () =>
        {
            if (AppDataMount?.Id == mount.Id)
            {
                AppDataMount = null;
                AppDataPassphrase = string.Empty;
            }
            await SaveMountsAsync(Mounts.Where(candidate => candidate.Id != mount.Id));
            Mounts.Remove(mount);
            _provider = null;
            _activeMount = null;
            ShowMountRoot();
            Status = $"Removed mount {mount.Name}.";
        });
    }

    [RelayCommand]
    private async Task SignInAsync()
    {
        await RunUiOperationAsync(async () =>
        {
            if (string.IsNullOrWhiteSpace(ClientId))
            {
                throw new InvalidOperationException("Enter the client ID of an Entra SPA app registration.");
            }

            var scopes = ProviderKind == "OneDrive"
                ? new[] { "Files.Read", "User.Read" }
                : new[] { "https://storage.azure.com/user_impersonation" };
            Credential = await PlatformServices.Authentication.AcquireTokenAsync(TenantId, ClientId, scopes);
            Status = "Signed in. Save the mount to persist it locally.";
        });
    }

    [RelayCommand]
    private async Task OpenAsync()
    {
        if (SelectedItem is null)
        {
            return;
        }

        if (SelectedItem.Metadata?.TryGetValue(EntryKindKey, out var kind) == true)
        {
            if (kind == "playlist"
                && SelectedItem.Metadata.TryGetValue(PlaylistIdKey, out var playlistId))
            {
                var playlist = Playlists.First(item => item.Id == playlistId);
                ShowPlaylist(playlist);
                return;
            }
            if (kind is "playlistItem" or "offline")
            {
                await PlayAsync();
                return;
            }
        }

        if (_activeMount is null)
        {
            if (SelectedItem.Metadata?.TryGetValue(MountIdKey, out var mountId) == true)
            {
                var mount = Mounts.Single(candidate => candidate.Id == mountId);
                await OpenMountAsync(mount);
            }

            return;
        }

        if (SelectedItem.IsDirectory)
        {
            CurrentPath = SelectedItem.Path;
            await RunUiOperationAsync(LoadCurrentPathAsync);
        }
        else if (MediaTypes.IsVideo(SelectedItem))
        {
            await PlayAsync();
        }
        else if (MediaTypes.IsSubtitle(SelectedItem))
        {
            await ApplyCloudSubtitleAsync(SelectedItem);
        }
    }

    [RelayCommand]
    private async Task UpAsync()
    {
        await RunUiOperationAsync(async () =>
        {
            if (_activeMount is null)
            {
                if (CurrentLocation != "Mounts") ShowMountRoot();
                return;
            }

            if (string.IsNullOrEmpty(CurrentPath))
            {
                ShowMountRoot();
                return;
            }

            CurrentPath = Path.GetDirectoryName(CurrentPath)?.Replace('\\', '/') ?? string.Empty;
            await LoadCurrentPathAsync();
        });
    }

    [RelayCommand]
    private async Task RefreshAsync()
    {
        await RunUiOperationAsync(async () =>
        {
            if (_activeMount is not null)
            {
                await LoadCurrentPathAsync();
                return;
            }

            if (IsOfflineView)
            {
                ShowOffline();
                return;
            }

            if (_currentPlaylist is not null)
            {
                ShowPlaylist(_currentPlaylist);
                return;
            }

            if (IsPlaylistView)
            {
                ShowPlaylists();
                return;
            }

            ShowMountRoot();
        });
    }

    [RelayCommand]
    private async Task PlayAsync()
    {
        if (SelectedItem is null || !MediaTypes.IsVideo(SelectedItem))
        {
            Status = "Select a video inside a mount first.";
            return;
        }

        var requestId = Interlocked.Increment(ref _playbackRequestId);
        var selected = SelectedItem;
        IsBusy = true;
        Status = $"Loading {selected.Name}…";
        try
        {
            var target = await ResolveSelectedVideoForPlaybackAsync(selected);
            var mount = target.Mount;
            var provider = target.Provider;
            var video = target.Video;
            var content = target.Content;
            var offlineUri = target.OfflineUri;
            if (_playingVideo is not null && !_playingVideo.Path.Equals(video.Path, StringComparison.Ordinal))
            {
                Interlocked.Increment(ref _subtitleRequestId);
                SelectedSubtitle = null;
                _localSubtitle = null;
                SelectedSubtitleLabel = "Auto-detect adjacent or embedded subtitles";
            }
            _playingVideo = null;
            await PlatformServices.Playback.StopAndShowLoadingAsync(video.Name);
            if (requestId != _playbackRequestId) return;

            var siblings = offlineUri is not null && selected.Metadata?.ContainsKey(EntryKindKey) == true
                ? []
                : _activeMount?.Id == mount.Id
                ? Items.ToArray()
                : await provider.ListAsync(GetParentPath(video.Path));
            var plan = PlaybackPlanner.Create(video, content, siblings);
            var subtitle = await GetSubtitleWebVttAsync(video, provider, siblings);
            if (requestId != _playbackRequestId) return;

            var startSeconds = GetOptionalDouble(selected, StartSecondsKey);
            var endSeconds = GetOptionalDouble(selected, EndSecondsKey);
            await PlatformServices.Playback.PlayAsync(
                plan,
                subtitle,
                SubtitleOffsetMilliseconds,
                startSeconds,
                endSeconds,
                BuildMediaKey(mount.Id, video),
                SelectedConversionResolution?.Width ?? 854,
                (long)(Math.Max(0, ConvertedCacheSizeMb) * 1024 * 1024));
            if (requestId != _playbackRequestId) return;

            _playingVideo = video;
            AddHistoryEntry(mount.Id, video, startSeconds, endSeconds);
            await SaveStateAsync();
            Status = plan.Mode == PlaybackMode.Direct
                ? $"Playing {video.Name}."
                : $"Playing {video.Name} with ffmpeg.wasm.";
        }
        catch (Exception exception)
        {
            if (requestId == _playbackRequestId) Status = exception.Message;
        }
        finally
        {
            if (requestId == _playbackRequestId) IsBusy = false;
        }
    }

    [RelayCommand]
    private async Task ChooseLocalSubtitleAsync()
    {
        await RunUiOperationAsync(async () =>
        {
            var requestId = Interlocked.Increment(ref _subtitleRequestId);
            _localSubtitle = await PlatformServices.Playback.PickSubtitleAsync();
            if (_localSubtitle is not null && requestId == _subtitleRequestId)
            {
                SelectedSubtitle = null;
                SelectedSubtitleLabel = _localSubtitle.Name;
                var webVtt = SubtitleConverter.ToWebVtt(
                    _localSubtitle.Content,
                    Path.GetExtension(_localSubtitle.Name),
                    TimeSpan.FromMilliseconds(SubtitleOffsetMilliseconds));
                await PlatformServices.Playback.SetSubtitleAsync(webVtt);
            }
        });
    }

    [RelayCommand]
    private async Task ClearSubtitleAsync()
    {
        Interlocked.Increment(ref _subtitleRequestId);
        SelectedSubtitle = null;
        _localSubtitle = null;
        SelectedSubtitleLabel = "Auto-detect adjacent or embedded subtitles";
        try
        {
            await PlatformServices.Playback.SetSubtitleAsync(null);
        }
        catch (Exception exception)
        {
            Status = exception.Message;
        }
    }

    private async Task InitializeAsync()
    {
        await RunUiOperationAsync(async () =>
        {
            var json = await PlatformServices.Mounts.LoadAsync();
            if (!string.IsNullOrWhiteSpace(json))
            {
                try
                {
                    _appState = AppStateSerializer.FromJson(json);
                }
                catch (JsonException)
                {
                    _appState = new AppState
                    {
                        Mounts = JsonSerializer.Deserialize(json, MountJsonContext.Default.ListMountDefinition) ?? []
                    };
                }
            }

            if (!_appState.Playlists.Any(item => item.Kind == PlaylistKind.History))
            {
                _appState.Playlists.Add(AppState.CreateHistoryPlaylist());
            }
            foreach (var mount in _appState.Mounts) Mounts.Add(mount);
            foreach (var playlist in _appState.Playlists) Playlists.Add(playlist);
            foreach (var offline in _appState.OfflineMedia) OfflineFiles.Add(offline);
            AppDataPath = _appState.AppDataSync.BlobPath;
            AppDataMount = Mounts.FirstOrDefault(item => item.Id == _appState.AppDataSync.BootstrapMountId);
            SelectedPlaylist = Playlists.FirstOrDefault(item => !item.IsAutomatic);
            ShowMountRoot();
            await RefreshOfflineStorageAsync();
            await RefreshConvertedCacheAsync();
            Status = Mounts.Count == 0
                ? "Use File → Add storage mount to get started."
                : $"{Mounts.Count} mount{(Mounts.Count == 1 ? string.Empty : "s")}.";
        });
    }

    private async Task OpenMountAsync(MountDefinition mount)
    {
        await RunUiOperationAsync(async () =>
        {
            _activeMount = mount;
            _provider = CreateProvider(mount);
            CurrentPath = string.Empty;
            await LoadCurrentPathAsync();
            Status = $"Opened {mount.Name}.";
        });
    }

    private IMediaProvider CreateProvider(MountDefinition mount)
    {
        if (mount.ProviderKind == "OneDrive")
        {
            return new OneDriveMediaProvider(Required(mount.Credential, "OAuth access token"), mount.RootPath);
        }

        var uri = new Uri(Required(mount.Endpoint, "SAS URL or storage endpoint"), UriKind.Absolute);
        var accountKey = LooksLikeAccessToken(mount.Credential) ? null : NullIfEmpty(mount.Credential);
        var accessToken = LooksLikeAccessToken(mount.Credential) ? mount.Credential : null;
        return mount.ProviderKind switch
        {
            "Azure Blob" => new AzureBlobMediaProvider(new AzureBlobOptions
            {
                ContainerUri = uri,
                AccountName = NullIfEmpty(mount.AccountName),
                AccountKey = accountKey,
                AccessToken = accessToken,
                RootPrefix = mount.RootPath
            }),
            "Azure Files" => new AzureFilesMediaProvider(new AzureFilesOptions
            {
                ShareUri = uri,
                AccountName = NullIfEmpty(mount.AccountName),
                AccountKey = accountKey,
                AccessToken = accessToken,
                RootPath = mount.RootPath
            }),
            _ => throw new InvalidOperationException($"Unknown provider '{mount.ProviderKind}'.")
        };
    }

    private void ShowPlaylist(Playlist playlist)
    {
        _provider = null;
        _activeMount = null;
        _currentPlaylist = playlist;
        IsOfflineView = false;
        IsPlaylistView = true;
        SelectedPlaylist = playlist;
        CurrentLocation = playlist.IsAutomatic ? $"Auto playlist · {playlist.Name}" : $"Playlist · {playlist.Name}";
        Items.Clear();
        foreach (var entry in playlist.Entries)
        {
            var mount = Mounts.FirstOrDefault(item => item.Id == entry.MountId);
            Items.Add(CreateVirtualMediaItem(
                "playlistItem",
                entry.MountId,
                entry.Path,
                entry.Name,
                metadata: new Dictionary<string, string>
                {
                    [PlaylistIdKey] = playlist.Id,
                    [StartSecondsKey] = entry.StartSeconds?.ToString(System.Globalization.CultureInfo.InvariantCulture) ?? string.Empty,
                    [EndSecondsKey] = entry.EndSeconds?.ToString(System.Globalization.CultureInfo.InvariantCulture) ?? string.Empty,
                    ["mountName"] = mount?.Name ?? "Missing mount"
                }));
        }
        SelectedItem = null;
        Status = $"{playlist.Entries.Count} item{(playlist.Entries.Count == 1 ? string.Empty : "s")}.";
    }

    private Playlist EnsureHistoryPlaylist()
    {
        var history = Playlists.FirstOrDefault(item => item.Kind == PlaylistKind.History);
        if (history is not null) return history;
        history = AppState.CreateHistoryPlaylist();
        Playlists.Insert(0, history);
        return history;
    }

    private void AddHistoryEntry(
        string mountId,
        MediaItem video,
        double? startSeconds,
        double? endSeconds)
    {
        var history = EnsureHistoryPlaylist();
        history.Entries.Insert(0, new PlaylistEntry
        {
            MountId = mountId,
            Path = video.Path,
            Name = video.Name,
            StartSeconds = startSeconds,
            EndSeconds = endSeconds,
            AddedAt = DateTimeOffset.UtcNow
        });
        const int historyLimit = 250;
        if (history.Entries.Count > historyLimit)
        {
            history.Entries.RemoveRange(historyLimit, history.Entries.Count - historyLimit);
        }
    }

    private async Task CacheMediaItemAsync(MediaItem item)
    {
        var mountId = GetItemMountId(item);
        var mount = Mounts.FirstOrDefault(value => value.Id == mountId)
            ?? throw new InvalidOperationException("The selected video's mount is unavailable.");
        var provider = _activeMount?.Id == mount.Id && _provider is not null
            ? _provider
            : CreateProvider(mount);
        var key = GetOfflineKey(mount.Id, item.Path);
        if (OfflineFiles.Any(value => value.MountId == mount.Id && value.Path == item.Path)
            && await PlatformServices.Offline.ResolveAsync(key) is not null)
        {
            return;
        }
        var resolved = item.Metadata?.ContainsKey(EntryKindKey) == true
            ? await ResolveProviderItemAsync(provider, item.Path)
            : item;
        Status = $"Downloading {resolved.Name} for offline use…";
        var content = await provider.GetContentAsync(resolved);
        key = GetOfflineKey(mount.Id, resolved.Path);
        await PlatformServices.Offline.CacheAsync(
            key,
            content.Uri,
            mount.ProviderKind is "Azure Blob" or "Azure Files"
            && LooksLikeAccessToken(mount.Credential)
                ? mount.Credential
                : null);

        var old = OfflineFiles.FirstOrDefault(value => value.MountId == mount.Id && value.Path == resolved.Path);
        if (old is not null) OfflineFiles.Remove(old);
        OfflineFiles.Add(new OfflineMediaMetadata
        {
            MountId = mount.Id,
            Path = resolved.Path,
            SizeBytes = resolved.Size,
            DownloadedAt = DateTimeOffset.UtcNow,
            LocalFileName = resolved.Name
        });
        await SaveStateAsync();
        await RefreshOfflineStorageAsync();
        Status = $"{resolved.Name} is available offline.";
    }

    private async Task CachePlaylistEntryAsync(PlaylistEntry entry)
    {
        var item = CreateVirtualMediaItem(
            "playlistItem",
            entry.MountId,
            entry.Path,
            entry.Name,
            metadata: new Dictionary<string, string>());
        await CacheMediaItemAsync(item);
    }

    private async Task<MediaItem> ResolveProviderItemAsync(IMediaProvider provider, string path)
    {
        var siblings = await provider.ListAsync(GetParentPath(path));
        return siblings.FirstOrDefault(item => item.Path.Equals(path, StringComparison.OrdinalIgnoreCase))
            ?? throw new FileNotFoundException($"'{path}' no longer exists in its provider.");
    }

    private async Task<(MountDefinition Mount, IMediaProvider Provider, MediaItem Video, MediaContent Content, Uri? OfflineUri)>
        ResolveSelectedVideoForPlaybackAsync(MediaItem selected)
    {
        var mountId = GetItemMountId(selected);
        var mount = Mounts.FirstOrDefault(item => item.Id == mountId)
            ?? throw new InvalidOperationException("The selected video mount is unavailable.");
        var provider = _activeMount?.Id == mount.Id && _provider is not null
            ? _provider
            : CreateProvider(mount);
        var offlineUri = await PlatformServices.Offline.ResolveAsync(GetOfflineKey(mount.Id, selected.Path));
        var video = selected.Metadata?.ContainsKey(EntryKindKey) == true && offlineUri is null
            ? await ResolveProviderItemAsync(provider, selected.Path)
            : selected;
        var content = offlineUri is null
            ? await provider.GetContentAsync(video)
            : new MediaContent(offlineUri, video.ContentType, video.Size);
        return (mount, provider, video, content, offlineUri);
    }

    private async Task RefreshOfflineStorageAsync()
    {
        var estimate = await PlatformServices.Offline.EstimateAsync();
        OfflineStorageLabel =
            $"{FormatBytes(estimate.Usage)} used · {FormatBytes(Math.Max(0, estimate.Quota - estimate.Usage))} available";
    }

    [RelayCommand]
    private async Task ClearConvertedCacheAsync()
    {
        try
        {
            await PlatformServices.Playback.ClearConvertedCacheAsync();
            await RefreshConvertedCacheAsync();
            Status = "Converted segment cache cleared.";
        }
        catch (Exception exception)
        {
            Status = exception.Message;
        }
    }

    private async Task RefreshConvertedCacheAsync()
    {
        var usage = await PlatformServices.Playback.GetConvertedCacheUsageAsync();
        ConvertedCacheLabel =
            $"{FormatBytes(usage)} converted · {ConvertedCacheSizeMb:0} MB limit";
    }

    private static MediaItem CreateVirtualMediaItem(
        string kind,
        string mountId,
        string path,
        string name,
        long? size = null,
        IReadOnlyDictionary<string, string>? metadata = null)
    {
        var values = new Dictionary<string, string>(metadata ?? new Dictionary<string, string>())
        {
            [EntryKindKey] = kind,
            [MountIdKey] = mountId
        };
        return new MediaItem(path, name, false, size, Metadata: values);
    }

    private string? GetItemMountId(MediaItem item) =>
        item.Metadata?.TryGetValue(MountIdKey, out var mountId) == true
            ? mountId
            : _activeMount?.Id;

    private static double? GetOptionalDouble(MediaItem item, string key) =>
        item.Metadata?.TryGetValue(key, out var value) == true
        && double.TryParse(value, System.Globalization.CultureInfo.InvariantCulture, out var parsed)
            ? parsed
            : null;

    private static string GetParentPath(string path) =>
        Path.GetDirectoryName(path)?.Replace('\\', '/') ?? string.Empty;

    private static string GetOfflineKey(string mountId, string path) => $"{mountId}|{path}";

    private static string BuildMediaKey(string mountId, MediaItem video) =>
        $"{mountId}|{video.Path}|{video.Size}|{video.LastModified:O}";

    private static string RemoveQuery(string endpoint)
    {
        if (!Uri.TryCreate(endpoint, UriKind.Absolute, out var uri)) return endpoint;
        return new UriBuilder(uri) { Query = string.Empty }.Uri.ToString();
    }

    private static IReadOnlyList<Playlist> MergePlaylists(
        IEnumerable<Playlist> remote,
        IEnumerable<Playlist> local)
    {
        var result = remote.ToDictionary(item => item.Id);
        foreach (var localPlaylist in local)
        {
            if (!result.TryGetValue(localPlaylist.Id, out var remotePlaylist))
            {
                result[localPlaylist.Id] = localPlaylist;
                continue;
            }

            var entries = remotePlaylist.Entries
                .Concat(localPlaylist.Entries)
                .GroupBy(item => (
                    item.MountId,
                    item.Path,
                    item.StartSeconds,
                    item.EndSeconds))
                .Select(group => group.First())
                .ToList();
            if (remotePlaylist.Kind == PlaylistKind.History)
            {
                entries = entries
                    .OrderByDescending(item => item.AddedAt ?? DateTimeOffset.MinValue)
                    .ToList();
            }
            result[localPlaylist.Id] = remotePlaylist with
            {
                KeepOffline = remotePlaylist.KeepOffline || localPlaylist.KeepOffline,
                Entries = entries
            };
        }
        return result.Values.ToArray();
    }

    private static string FormatBytes(long value)
    {
        string[] units = ["B", "KB", "MB", "GB", "TB"];
        var size = (double)value;
        var unit = 0;
        while (size >= 1024 && unit < units.Length - 1)
        {
            size /= 1024;
            unit++;
        }
        return $"{size:0.##} {units[unit]}";
    }

    private void ShowMountRoot()
    {
        _provider = null;
        _activeMount = null;
        IsOfflineView = false;
        IsPlaylistView = false;
        CurrentPath = string.Empty;
        CurrentLocation = "Mounts";
        Items.Clear();
        foreach (var mount in Mounts.OrderBy(mount => mount.Name, StringComparer.OrdinalIgnoreCase))
        {
            Items.Add(new MediaItem(
                mount.Id,
                mount.Name,
                true,
                Metadata: new Dictionary<string, string>
                {
                    [MountIdKey] = mount.Id,
                    ["provider"] = mount.ProviderKind
                }));
        }

        SelectedItem = null;
    }

    private async Task LoadCurrentPathAsync()
    {
        IsOfflineView = false;
        IsPlaylistView = false;
        var loaded = await _provider!.ListAsync(CurrentPath);
        Items.Clear();
        foreach (var item in loaded)
        {
            Items.Add(item);
        }

        CurrentLocation = string.IsNullOrEmpty(CurrentPath)
            ? _activeMount!.Name
            : $"{_activeMount!.Name}/{CurrentPath}";
        SelectedItem = null;
        Status = $"{loaded.Count} items.";
    }

    private async Task SaveMountsAsync(IEnumerable<MountDefinition> mounts)
    {
        await SaveStateAsync(mounts);
    }

    private async Task SaveStateAsync(IEnumerable<MountDefinition>? mounts = null, bool sync = true)
    {
        _appState = new AppState
        {
            Mounts = (mounts ?? Mounts).ToList(),
            Playlists = Playlists.ToList(),
            OfflineMedia = OfflineFiles.ToList(),
            AppDataSync = new AppDataSyncSettings
            {
                BootstrapMountId = AppDataMount?.Id,
                BlobPath = string.IsNullOrWhiteSpace(AppDataPath)
                    ? ".medius-app-state.json.enc"
                    : AppDataPath.Trim('/')
            }
        };
        await PlatformServices.Mounts.SaveAsync(AppStateSerializer.ToJson(_appState));
        if (sync
            && AppDataMount is not null
            && !string.IsNullOrWhiteSpace(AppDataPassphrase))
        {
            await PushAppDataAsync(saveLocalFirst: false);
        }
    }

    private async Task ApplyCloudSubtitleAsync(MediaItem subtitle)
    {
        var requestId = Interlocked.Increment(ref _subtitleRequestId);
        SelectedSubtitle = subtitle;
        _localSubtitle = null;
        SelectedSubtitleLabel = subtitle.Name;
        try
        {
            var webVtt = await ReadSubtitleWebVttAsync(subtitle);
            if (requestId != _subtitleRequestId) return;

            await PlatformServices.Playback.SetSubtitleAsync(webVtt);
            if (requestId != _subtitleRequestId) return;

            Status = _playingVideo is null
                ? $"Selected {subtitle.Name} for the next video."
                : $"Showing {subtitle.Name}.";
        }
        catch (Exception exception)
        {
            if (requestId == _subtitleRequestId) Status = exception.Message;
        }
    }

    private async Task<string?> GetSubtitleWebVttAsync(
        MediaItem video,
        IMediaProvider provider,
        IEnumerable<MediaItem> siblings)
    {
        if (_localSubtitle is not null)
        {
            return SubtitleConverter.ToWebVtt(
                _localSubtitle.Content,
                Path.GetExtension(_localSubtitle.Name),
                TimeSpan.FromMilliseconds(SubtitleOffsetMilliseconds));
        }

        var subtitle = SelectedSubtitle
            ?? SubtitleDiscovery.FindAdjacent(video, siblings).FirstOrDefault();
        if (subtitle is null) return null;

        SelectedSubtitleLabel = subtitle.Name;
        return await ReadSubtitleWebVttAsync(subtitle, provider);
    }

    private async Task<string> ReadSubtitleWebVttAsync(
        MediaItem subtitle,
        IMediaProvider? provider = null)
    {
        await using var stream = await (provider ?? _provider!).OpenReadAsync(subtitle);
        using var reader = new StreamReader(stream, Encoding.UTF8, detectEncodingFromByteOrderMarks: true);
        var content = await reader.ReadToEndAsync();
        return SubtitleConverter.ToWebVtt(
            content,
            subtitle.Extension,
            TimeSpan.FromMilliseconds(SubtitleOffsetMilliseconds));
    }

    partial void OnSubtitleFontSizePercentChanged(double value) => _ = ApplySubtitleStyleAsync();

    partial void OnSubtitleBackgroundOpacityPercentChanged(double value) => _ = ApplySubtitleStyleAsync();

    private async Task ApplySubtitleStyleAsync()
    {
        try
        {
            await PlatformServices.Playback.SetSubtitleStyleAsync(
                SubtitleFontSizePercent,
                SubtitleBackgroundOpacityPercent / 100);
        }
        catch (Exception exception)
        {
            Status = exception.Message;
        }
    }

    private async Task RunUiOperationAsync(Func<Task> operation)
    {
        if (IsBusy)
        {
            return;
        }

        IsBusy = true;
        try
        {
            await operation();
        }
        catch (Exception exception)
        {
            Status = exception.Message;
        }
        finally
        {
            IsBusy = false;
        }
    }

    private static bool LooksLikeAccessToken(string value) =>
        value.StartsWith("eyJ", StringComparison.Ordinal) && value.Count(character => character == '.') == 2;

    private static string Required(string value, string label) =>
        string.IsNullOrWhiteSpace(value) ? throw new InvalidOperationException($"Enter a {label}.") : value.Trim();

    private static string? NullIfEmpty(string value) => string.IsNullOrWhiteSpace(value) ? null : value.Trim();
}
