using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Medius.Services;

/// <summary>
/// Encrypts and decrypts arbitrary UTF-8 JSON (typically a serialized <see cref="AppState"/>) using
/// AES-256-GCM with a key derived from a user-supplied passphrase via PBKDF2-HMAC-SHA256.
///
/// Each call to <see cref="Encrypt"/> generates a fresh random salt and nonce, and the resulting
/// envelope records everything needed to decrypt (version, KDF iteration count, salt, nonce, and the
/// authentication tag) alongside the ciphertext. The passphrase itself is never included in the
/// envelope or otherwise persisted by this type.
/// </summary>
public static class AppStateCrypto
{
    /// <summary>The current envelope schema version produced by <see cref="Encrypt"/>.</summary>
    public const int CurrentEnvelopeVersion = 1;

    private const int SaltSizeBytes = 16;
    private const int NonceSizeBytes = 12;
    private const int TagSizeBytes = 16;
    private const int KeySizeBytes = 32; // AES-256
    private const int DefaultPbkdf2Iterations = 210_000;

    /// <summary>
    /// Additional authenticated data bound to every envelope. It is not secret, but tampering with it
    /// (or presenting ciphertext produced under a different AAD) will cause decryption to fail.
    /// </summary>
    private static readonly byte[] AssociatedData = Encoding.UTF8.GetBytes("medius-app-state-v1");

    /// <summary>
    /// Encrypts <paramref name="plaintextJson"/> with a key derived from <paramref name="passphrase"/>,
    /// returning a self-describing JSON envelope. The plaintext may be any UTF-8 JSON document; the
    /// caller is responsible for ensuring it does not contain the passphrase or other secrets it does
    /// not want to encrypt (this method has no dependency on the <see cref="AppState"/> shape).
    /// </summary>
    public static string Encrypt(string plaintextJson, string passphrase, int iterations = DefaultPbkdf2Iterations)
    {
        ArgumentNullException.ThrowIfNull(plaintextJson);
        ArgumentException.ThrowIfNullOrWhiteSpace(passphrase);
        if (iterations <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(iterations), "PBKDF2 iteration count must be positive.");
        }

        var salt = RandomNumberGenerator.GetBytes(SaltSizeBytes);
        var nonce = RandomNumberGenerator.GetBytes(NonceSizeBytes);
        var key = DeriveKey(passphrase, salt, iterations);

        var plaintextBytes = Encoding.UTF8.GetBytes(plaintextJson);
        var ciphertext = new byte[plaintextBytes.Length];
        var tag = new byte[TagSizeBytes];

        try
        {
            using var aesGcm = new AesGcm(key, TagSizeBytes);
            aesGcm.Encrypt(nonce, plaintextBytes, ciphertext, tag, AssociatedData);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(key);
        }

        var envelope = new AppStateEnvelope
        {
            Version = CurrentEnvelopeVersion,
            Iterations = iterations,
            Salt = Convert.ToBase64String(salt),
            Nonce = Convert.ToBase64String(nonce),
            Tag = Convert.ToBase64String(tag),
            Ciphertext = Convert.ToBase64String(ciphertext),
        };

        return JsonSerializer.Serialize(envelope, AppStateCryptoJsonContext.Default.AppStateEnvelope);
    }

    /// <summary>
    /// Decrypts an envelope produced by <see cref="Encrypt"/>, returning the original UTF-8 JSON
    /// plaintext. Throws <see cref="CryptographicException"/> when <paramref name="passphrase"/> is
    /// wrong or the envelope has been tampered with (the GCM authentication tag will not verify).
    /// </summary>
    public static string Decrypt(string envelopeJson, string passphrase)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(envelopeJson);
        ArgumentException.ThrowIfNullOrWhiteSpace(passphrase);

        var envelope = JsonSerializer.Deserialize(envelopeJson, AppStateCryptoJsonContext.Default.AppStateEnvelope)
            ?? throw new InvalidDataException("The app-state envelope is empty or malformed.");

        if (envelope.Version != CurrentEnvelopeVersion)
        {
            throw new NotSupportedException($"Unsupported app-state envelope version {envelope.Version}.");
        }

        byte[] salt, nonce, tag, ciphertext;
        try
        {
            salt = Convert.FromBase64String(envelope.Salt);
            nonce = Convert.FromBase64String(envelope.Nonce);
            tag = Convert.FromBase64String(envelope.Tag);
            ciphertext = Convert.FromBase64String(envelope.Ciphertext);
        }
        catch (FormatException ex)
        {
            throw new InvalidDataException("The app-state envelope contains invalid base64 data.", ex);
        }

        var key = DeriveKey(passphrase, salt, envelope.Iterations);
        var plaintext = new byte[ciphertext.Length];

        try
        {
            using var aesGcm = new AesGcm(key, tag.Length);
            aesGcm.Decrypt(nonce, ciphertext, tag, plaintext, AssociatedData);
        }
        catch (CryptographicException ex)
        {
            throw new CryptographicException(
                "Failed to decrypt app-state: the passphrase is wrong or the data is corrupted.", ex);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(key);
        }

        return Encoding.UTF8.GetString(plaintext);
    }

    private static byte[] DeriveKey(string passphrase, byte[] salt, int iterations) =>
        Rfc2898DeriveBytes.Pbkdf2(
            Encoding.UTF8.GetBytes(passphrase),
            salt,
            iterations,
            HashAlgorithmName.SHA256,
            KeySizeBytes);
}

/// <summary>The versioned, self-describing JSON envelope produced by <see cref="AppStateCrypto.Encrypt"/>.</summary>
public sealed record AppStateEnvelope
{
    public int Version { get; init; }

    public int Iterations { get; init; }

    public required string Salt { get; init; }

    public required string Nonce { get; init; }

    public required string Tag { get; init; }

    public required string Ciphertext { get; init; }
}

[JsonSerializable(typeof(AppStateEnvelope))]
internal sealed partial class AppStateCryptoJsonContext : JsonSerializerContext;
