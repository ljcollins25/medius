using System.Text.Json;

namespace Medius.Services;

/// <summary>
/// Convenience helpers that combine <see cref="AppState"/> JSON (de)serialization with
/// <see cref="AppStateCrypto"/> encryption, for the common case of round-tripping the whole document.
/// </summary>
public static class AppStateSerializer
{
    public static string ToJson(AppState state) =>
        JsonSerializer.Serialize(state, AppStateJsonContext.Default.AppState);

    public static AppState FromJson(string json) =>
        JsonSerializer.Deserialize(json, AppStateJsonContext.Default.AppState)
            ?? throw new InvalidDataException("The app-state document is empty or malformed.");

    /// <summary>Serializes and encrypts <paramref name="state"/> into a portable envelope string.</summary>
    public static string Encrypt(AppState state, string passphrase) =>
        AppStateCrypto.Encrypt(ToJson(state), passphrase);

    /// <summary>Decrypts and deserializes an envelope produced by <see cref="Encrypt"/>.</summary>
    public static AppState Decrypt(string envelopeJson, string passphrase) =>
        FromJson(AppStateCrypto.Decrypt(envelopeJson, passphrase));
}
