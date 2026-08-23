using System.Text.Json.Serialization;

namespace Medius.Services;

/// <summary>
/// The root document synchronized to cloud "app data" storage. It captures the user's configured
/// mounts, playlists (including the automatic History playlist), offline media metadata, and the
/// settings needed to bootstrap the encrypted sync itself. This document is never persisted in
/// plaintext to a mount; see <see cref="AppStateCrypto"/> for the encrypted envelope format.
/// </summary>
public sealed record AppState
{
    /// <summary>The current schema version written by this build.</summary>
    public const int CurrentVersion = 1;

    public int Version { get; init; } = CurrentVersion;

    public List<MountDefinition> Mounts { get; init; } = [];

    public List<Playlist> Playlists { get; init; } = [];

    public List<OfflineMediaMetadata> OfflineMedia { get; init; } = [];

    public AppDataSyncSettings AppDataSync { get; init; } = new();

    /// <summary>
    /// Creates the automatic "History" playlist that every app-state document should contain exactly once.
    /// </summary>
    public static Playlist CreateHistoryPlaylist(string name = "History") => new()
    {
        Id = HistoryPlaylistId,
        Name = name,
        Kind = PlaylistKind.History,
        IsAutomatic = true,
        KeepOffline = false,
        Entries = [],
    };

    public const string HistoryPlaylistId = "history";
}

/// <summary>Identifies whether a playlist is user-managed or maintained automatically by the app.</summary>
public enum PlaylistKind
{
    Custom = 0,
    History = 1,
}

public sealed record Playlist
{
    public string Id { get; init; } = Guid.NewGuid().ToString("N");

    public required string Name { get; init; }

    /// <summary>Distinguishes the automatic History playlist from user-created playlists.</summary>
    public PlaylistKind Kind { get; init; } = PlaylistKind.Custom;

    /// <summary>True for playlists the app maintains itself (currently only History).</summary>
    public bool IsAutomatic { get; init; }

    /// <summary>When true, entries in this playlist should be kept available offline.</summary>
    public bool KeepOffline { get; init; }

    public List<PlaylistEntry> Entries { get; init; } = [];
}

/// <summary>
/// A single reference to a piece of media within a mount, with an optional trim range
/// (e.g. resume position or a clipped segment) expressed in seconds.
/// </summary>
public sealed record PlaylistEntry
{
    public required string MountId { get; init; }

    public required string Path { get; init; }

    public required string Name { get; init; }

    /// <summary>Inclusive start offset, in seconds, or <see langword="null"/> to play from the beginning.</summary>
    public double? StartSeconds { get; init; }

    /// <summary>Exclusive end offset, in seconds, or <see langword="null"/> to play to the end.</summary>
    public double? EndSeconds { get; init; }

    /// <summary>When this entry was added; used to merge automatic History across devices.</summary>
    public DateTimeOffset? AddedAt { get; init; }
}

/// <summary>Tracks a piece of media that has been (or should be) downloaded for offline playback.</summary>
public sealed record OfflineMediaMetadata
{
    public required string MountId { get; init; }

    public required string Path { get; init; }

    public long? SizeBytes { get; init; }

    public DateTimeOffset? DownloadedAt { get; init; }

    /// <summary>Name of the cached file on local/offline storage, when downloaded.</summary>
    public string? LocalFileName { get; init; }

    /// <summary>Optional integrity hash (e.g. SHA-256, hex-encoded) of the downloaded content.</summary>
    public string? ContentHash { get; init; }
}

/// <summary>
/// Identifies where the encrypted app-state document lives so the app can bootstrap sync on a new
/// device. This intentionally never carries the passphrase used to encrypt/decrypt the document —
/// that must be supplied by the user (or a platform secret store) at runtime and is never serialized.
/// </summary>
public sealed record AppDataSyncSettings
{
    /// <summary>The <see cref="MountDefinition.Id"/> of the mount that hosts the encrypted app-state blob.</summary>
    public string? BootstrapMountId { get; init; }

    /// <summary>Path, relative to the bootstrap mount's root, of the encrypted app-state document.</summary>
    public string BlobPath { get; init; } = ".medius-app-state.json.enc";
}

[JsonSerializable(typeof(AppState))]
[JsonSerializable(typeof(Playlist))]
[JsonSerializable(typeof(PlaylistEntry))]
[JsonSerializable(typeof(OfflineMediaMetadata))]
[JsonSerializable(typeof(AppDataSyncSettings))]
internal sealed partial class AppStateJsonContext : JsonSerializerContext;
