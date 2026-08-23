using Azure;
using Azure.Core;
using Azure.Storage;
using Azure.Storage.Blobs;
using Azure.Storage.Files.Shares;

namespace Medius.Providers.Azure;

internal static class StorageClientFactory
{
    public static BlobContainerClient CreateBlobContainer(AzureBlobOptions options)
    {
        if (!string.IsNullOrWhiteSpace(options.AccountKey))
        {
            var accountName = GetAccountName(options.ContainerUri, options.AccountName);
            return new BlobContainerClient(options.ContainerUri, new StorageSharedKeyCredential(accountName, options.AccountKey));
        }

        if (!string.IsNullOrWhiteSpace(options.AccessToken))
        {
            return new BlobContainerClient(options.ContainerUri, new FixedAccessTokenCredential(options.AccessToken));
        }

        return new BlobContainerClient(options.ContainerUri);
    }

    public static ShareClient CreateShare(AzureFilesOptions options)
    {
        if (!string.IsNullOrWhiteSpace(options.AccountKey))
        {
            var accountName = GetAccountName(options.ShareUri, options.AccountName);
            return new ShareClient(options.ShareUri, new StorageSharedKeyCredential(accountName, options.AccountKey));
        }

        if (!string.IsNullOrWhiteSpace(options.AccessToken))
        {
            return new ShareClient(options.ShareUri, new FixedAccessTokenCredential(options.AccessToken));
        }

        return new ShareClient(options.ShareUri);
    }

    private static string GetAccountName(Uri uri, string? explicitName)
    {
        if (!string.IsNullOrWhiteSpace(explicitName))
        {
            return explicitName;
        }

        var hostPart = uri.Host.Split('.')[0];
        return string.IsNullOrWhiteSpace(hostPart)
            ? throw new ArgumentException("An Azure Storage account name is required.")
            : hostPart;
    }

    private sealed class FixedAccessTokenCredential(string token) : TokenCredential
    {
        public override AccessToken GetToken(TokenRequestContext requestContext, CancellationToken cancellationToken) =>
            new(token, DateTimeOffset.UtcNow.AddMinutes(30));

        public override ValueTask<AccessToken> GetTokenAsync(
            TokenRequestContext requestContext,
            CancellationToken cancellationToken) =>
            ValueTask.FromResult(GetToken(requestContext, cancellationToken));
    }
}
