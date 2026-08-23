using System.Collections.ObjectModel;
using System.Text;
using System.Text.Json;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Medius.Core;
using Medius.Providers.Azure;
using Medius.Services;

namespace Medius.ViewModels;

public partial class MainViewModel : ViewModelBase
{
    private const string MountIdKey = "medius.mountId";
    private IMediaProvider? _provider;
    private MountDefinition? _activeMount;
    private LocalSubtitle? _localSubtitle;
    private MediaItem? _playingVideo;
    private int _playbackRequestId;
    private int _subtitleRequestId;

    public MainViewModel()
    {
        ProviderKinds = ["Azure Blob", "Azure Files", "OneDrive"];
        _ = InitializeAsync();
    }

    public IReadOnlyList<string> ProviderKinds { get; }

    public ObservableCollection<MountDefinition> Mounts { get; } = [];

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
    private async Task PlayAsync()
    {
        if (_provider is null || SelectedItem is null || !MediaTypes.IsVideo(SelectedItem))
        {
            Status = "Select a video inside a mount first.";
            return;
        }

        var requestId = Interlocked.Increment(ref _playbackRequestId);
        var video = SelectedItem;
        if (_playingVideo is not null && !_playingVideo.Path.Equals(video.Path, StringComparison.Ordinal))
        {
            Interlocked.Increment(ref _subtitleRequestId);
            SelectedSubtitle = null;
            _localSubtitle = null;
            SelectedSubtitleLabel = "Auto-detect adjacent or embedded subtitles";
        }
        _playingVideo = null;
        IsBusy = true;
        Status = $"Loading {video.Name}…";
        try
        {
            await PlatformServices.Playback.StopAndShowLoadingAsync(video.Name);
            var content = await _provider.GetContentAsync(video);
            if (requestId != _playbackRequestId) return;

            var plan = PlaybackPlanner.Create(video, content, Items);
            var subtitle = await GetSubtitleWebVttAsync(video);
            if (requestId != _playbackRequestId) return;

            await PlatformServices.Playback.PlayAsync(plan, subtitle, SubtitleOffsetMilliseconds);
            if (requestId != _playbackRequestId) return;

            _playingVideo = video;
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
                var mounts = JsonSerializer.Deserialize(json, MountJsonContext.Default.ListMountDefinition) ?? [];
                foreach (var mount in mounts)
                {
                    Mounts.Add(mount);
                }
            }

            ShowMountRoot();
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

    private void ShowMountRoot()
    {
        _provider = null;
        _activeMount = null;
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
        var json = JsonSerializer.Serialize(mounts.ToList(), MountJsonContext.Default.ListMountDefinition);
        await PlatformServices.Mounts.SaveAsync(json);
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

    private async Task<string?> GetSubtitleWebVttAsync(MediaItem video)
    {
        if (_localSubtitle is not null)
        {
            return SubtitleConverter.ToWebVtt(
                _localSubtitle.Content,
                Path.GetExtension(_localSubtitle.Name),
                TimeSpan.FromMilliseconds(SubtitleOffsetMilliseconds));
        }

        var subtitle = SelectedSubtitle
            ?? SubtitleDiscovery.FindAdjacent(video, Items).FirstOrDefault();
        if (subtitle is null) return null;

        SelectedSubtitleLabel = subtitle.Name;
        return await ReadSubtitleWebVttAsync(subtitle);
    }

    private async Task<string> ReadSubtitleWebVttAsync(MediaItem subtitle)
    {
        await using var stream = await _provider!.OpenReadAsync(subtitle);
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
