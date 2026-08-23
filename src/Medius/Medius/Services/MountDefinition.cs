using System.Text.Json.Serialization;

namespace Medius.Services;

public sealed record MountDefinition
{
    public string Id { get; init; } = Guid.NewGuid().ToString("N");

    public required string Name { get; init; }

    public required string ProviderKind { get; init; }

    public string Endpoint { get; init; } = string.Empty;

    public string AccountName { get; init; } = string.Empty;

    public string Credential { get; init; } = string.Empty;

    public string RootPath { get; init; } = string.Empty;

    public string TenantId { get; init; } = "common";

    public string ClientId { get; init; } = string.Empty;
}

[JsonSerializable(typeof(List<MountDefinition>))]
internal sealed partial class MountJsonContext : JsonSerializerContext;
