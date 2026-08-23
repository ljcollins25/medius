using System.Text.Json;
using Medius.Services;

namespace Medius.Core.Tests;

public sealed class AppStateTests
{
    [Fact]
    public void RoundTripsAppStateThroughEncryptedEnvelope()
    {
        var state = new AppState
        {
            Mounts =
            [
                new MountDefinition
                {
                    Name = "Archive",
                    ProviderKind = "Azure Blob",
                    Endpoint = "https://archive.example.test/media?sig=test",
                }
            ],
            Playlists =
            [
                AppState.CreateHistoryPlaylist(),
                new Playlist
                {
                    Name = "Favorites",
                    KeepOffline = true,
                    Entries =
                    [
                        new PlaylistEntry
                        {
                            MountId = "mount-1",
                            Path = "movies/inception.mkv",
                            Name = "Inception",
                            StartSeconds = 120.5,
                            EndSeconds = 5400,
                            AddedAt = DateTimeOffset.Parse("2026-01-02T03:04:05Z"),
                        }
                    ],
                }
            ],
            OfflineMedia =
            [
                new OfflineMediaMetadata
                {
                    MountId = "mount-1",
                    Path = "movies/inception.mkv",
                    SizeBytes = 12_345_678,
                    LocalFileName = "inception.mkv",
                }
            ],
            AppDataSync = new AppDataSyncSettings
            {
                BootstrapMountId = "mount-1",
                BlobPath = ".medius-app-state.json.enc",
            },
        };

        var envelope = AppStateSerializer.Encrypt(state, "correct horse battery staple");
        var restored = AppStateSerializer.Decrypt(envelope, "correct horse battery staple");

        Assert.Equal(state.Version, restored.Version);
        Assert.Equal(state.Mounts.Single().Name, restored.Mounts.Single().Name);
        Assert.Equal(2, restored.Playlists.Count);
        Assert.Contains(restored.Playlists, p => p.Kind == PlaylistKind.History && p.IsAutomatic);

        var favorites = restored.Playlists.Single(p => p.Name == "Favorites");
        Assert.True(favorites.KeepOffline);
        var entry = Assert.Single(favorites.Entries);
        Assert.Equal("mount-1", entry.MountId);
        Assert.Equal("movies/inception.mkv", entry.Path);
        Assert.Equal(120.5, entry.StartSeconds);
        Assert.Equal(5400, entry.EndSeconds);
        Assert.Equal(DateTimeOffset.Parse("2026-01-02T03:04:05Z"), entry.AddedAt);

        var offline = Assert.Single(restored.OfflineMedia);
        Assert.Equal("inception.mkv", offline.LocalFileName);
        Assert.Equal("mount-1", restored.AppDataSync.BootstrapMountId);
    }

    [Fact]
    public void FailsToDecryptWithWrongPassphrase()
    {
        var envelope = AppStateCrypto.Encrypt("""{"hello":"world"}""", "right-passphrase");

        Assert.Throws<System.Security.Cryptography.CryptographicException>(
            () => AppStateCrypto.Decrypt(envelope, "wrong-passphrase"));
    }

    [Fact]
    public void FailsToDecryptWhenCiphertextIsTampered()
    {
        var envelope = AppStateCrypto.Encrypt("""{"hello":"world"}""", "a-passphrase");
        using var document = JsonDocument.Parse(envelope);
        var root = document.RootElement;
        var tamperedCiphertext = Convert.ToBase64String([0xFF, .. Convert.FromBase64String(root.GetProperty("Ciphertext").GetString()!)]);

        var tampered = JsonSerializer.Serialize(new
        {
            Version = root.GetProperty("Version").GetInt32(),
            Iterations = root.GetProperty("Iterations").GetInt32(),
            Salt = root.GetProperty("Salt").GetString(),
            Nonce = root.GetProperty("Nonce").GetString(),
            Tag = root.GetProperty("Tag").GetString(),
            Ciphertext = tamperedCiphertext,
        });

        Assert.ThrowsAny<Exception>(() => AppStateCrypto.Decrypt(tampered, "a-passphrase"));
    }

    [Fact]
    public void PlaylistEntrySerializesOptionalStartAndEndRange()
    {
        var withRange = new PlaylistEntry
        {
            MountId = "mount-1",
            Path = "clip.mp4",
            Name = "Clip",
            StartSeconds = 10,
            EndSeconds = 20,
        };
        var withoutRange = new PlaylistEntry
        {
            MountId = "mount-1",
            Path = "full.mp4",
            Name = "Full",
        };

        var state = new AppState { Playlists = [new Playlist { Name = "Mixed", Entries = [withRange, withoutRange] }] };
        var json = AppStateSerializer.ToJson(state);
        var restored = AppStateSerializer.FromJson(json);

        var restoredEntries = restored.Playlists.Single().Entries;
        var restoredWithRange = restoredEntries.Single(e => e.Name == "Clip");
        var restoredWithoutRange = restoredEntries.Single(e => e.Name == "Full");

        Assert.Equal(10, restoredWithRange.StartSeconds);
        Assert.Equal(20, restoredWithRange.EndSeconds);
        Assert.Null(restoredWithoutRange.StartSeconds);
        Assert.Null(restoredWithoutRange.EndSeconds);
    }

    [Fact]
    public void EncryptedEnvelopeDoesNotContainCredentialsOrPlaintext()
    {
        var state = new AppState
        {
            Mounts =
            [
                new MountDefinition
                {
                    Name = "Secret Mount",
                    ProviderKind = "Azure Blob",
                    Endpoint = "https://secret.example.test/media?sig=super-secret-signature",
                    Credential = "super-secret-shared-key-value",
                    AccountName = "secretaccount",
                }
            ],
        };

        var envelope = AppStateSerializer.Encrypt(state, "top-secret-passphrase");

        Assert.DoesNotContain("super-secret-shared-key-value", envelope);
        Assert.DoesNotContain("super-secret-signature", envelope);
        Assert.DoesNotContain("secretaccount", envelope);
        Assert.DoesNotContain("Secret Mount", envelope);
        Assert.DoesNotContain("top-secret-passphrase", envelope);

        using var document = JsonDocument.Parse(envelope);
        var propertyNames = document.RootElement.EnumerateObject().Select(p => p.Name).ToArray();
        Assert.Contains("Version", propertyNames);
        Assert.Contains("Salt", propertyNames);
        Assert.Contains("Nonce", propertyNames);
        Assert.Contains("Tag", propertyNames);
        Assert.Contains("Ciphertext", propertyNames);
        Assert.DoesNotContain(propertyNames, name => name.Contains("passphrase", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public void AppDataSyncSettingsHasNoPassphraseProperty()
    {
        var properties = typeof(AppDataSyncSettings).GetProperties();

        Assert.DoesNotContain(properties, p => p.Name.Contains("passphrase", StringComparison.OrdinalIgnoreCase)
            || p.Name.Contains("password", StringComparison.OrdinalIgnoreCase)
            || p.Name.Contains("secret", StringComparison.OrdinalIgnoreCase));
        Assert.Contains(properties, p => p.Name == nameof(AppDataSyncSettings.BootstrapMountId));
        Assert.Contains(properties, p => p.Name == nameof(AppDataSyncSettings.BlobPath));
    }

    [Fact]
    public void CreatesExactlyOneAutomaticHistoryPlaylistByConvention()
    {
        var history = AppState.CreateHistoryPlaylist();

        Assert.Equal(AppState.HistoryPlaylistId, history.Id);
        Assert.True(history.IsAutomatic);
        Assert.Equal(PlaylistKind.History, history.Kind);
        Assert.False(history.KeepOffline);
        Assert.Empty(history.Entries);
    }

    [Fact]
    public void DecryptsWebCryptoEnvelopeWhenConfigured()
    {
        var envelope = Environment.GetEnvironmentVariable("MEDIUS_TEST_WEBCRYPTO_ENVELOPE");
        if (string.IsNullOrWhiteSpace(envelope))
        {
            return;
        }

        Assert.Equal(
            """{"source":"webcrypto"}""",
            AppStateCrypto.Decrypt(envelope, "browser-passphrase"));
    }
}
