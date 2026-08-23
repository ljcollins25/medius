namespace Medius.Providers.Azure;

public sealed record AzureFilesOptions
{
    public required Uri ShareUri { get; init; }

    public string? AccountName { get; init; }

    public string? AccountKey { get; init; }

    public string? AccessToken { get; init; }

    public string RootPath { get; init; } = string.Empty;
}
