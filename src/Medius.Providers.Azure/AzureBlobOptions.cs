namespace Medius.Providers.Azure;

public sealed record AzureBlobOptions
{
    public required Uri ContainerUri { get; init; }

    public string? AccountName { get; init; }

    public string? AccountKey { get; init; }

    public string? AccessToken { get; init; }

    public string RootPrefix { get; init; } = string.Empty;
}
