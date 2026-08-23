using Azure.Storage.Blobs.Models;
using Azure.Storage.Blobs.Specialized;

namespace Medius.Providers.Azure;

public sealed class GhostBlobHydrator
{
    public const string TagPrefix = "ghostd_";
    public const string StateTag = $"{TagPrefix}state";
    public const string SizeTag = $"{TagPrefix}size";
    public const string BlockPrefixTag = $"{TagPrefix}block_prefix";

    public async Task<bool> HydrateIfNeededAsync(
        BlockBlobClient blob,
        CancellationToken cancellationToken = default)
    {
        var properties = await blob.GetPropertiesAsync(cancellationToken: cancellationToken);
        if (properties.Value.ContentLength != 0)
        {
            return false;
        }

        var tagsResponse = await blob.GetTagsAsync(cancellationToken: cancellationToken);
        var tags = new Dictionary<string, string>(tagsResponse.Value.Tags, StringComparer.OrdinalIgnoreCase);
        if (!tags.TryGetValue(StateTag, out var state)
            || !state.Equals("ghost", StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        if (!tags.TryGetValue(BlockPrefixTag, out var blockPrefix)
            || !tags.TryGetValue(SizeTag, out var sizeText)
            || !long.TryParse(sizeText, out var expectedSize))
        {
            throw new InvalidDataException($"Ghost blob '{blob.Name}' is missing valid size or block_prefix tags.");
        }

        var blockList = await blob.GetBlockListAsync(
            BlockListTypes.Uncommitted,
            cancellationToken: cancellationToken);
        var blocks = blockList.Value.UncommittedBlocks
            .Where(block => block.Name.StartsWith(blockPrefix, StringComparison.Ordinal))
            .OrderBy(block => block.Name, StringComparer.Ordinal)
            .ToArray();
        var stagedSize = blocks.Sum(block => block.SizeLong);

        if (stagedSize != expectedSize)
        {
            throw new InvalidDataException(
                $"Ghost blob '{blob.Name}' declares {expectedSize} bytes but has {stagedSize} matching staged bytes.");
        }

        var activeTags = tags
            .Where(tag => !tag.Key.StartsWith(TagPrefix, StringComparison.OrdinalIgnoreCase))
            .ToDictionary(tag => tag.Key, tag => tag.Value, StringComparer.OrdinalIgnoreCase);
        activeTags["archive_version"] = "1";
        activeTags[StateTag] = "active";

        await blob.CommitBlockListAsync(
            blocks.Select(block => block.Name),
            new CommitBlockListOptions
            {
                Conditions = new BlobRequestConditions { IfMatch = properties.Value.ETag },
                Metadata = properties.Value.Metadata,
                Tags = activeTags,
                HttpHeaders = new BlobHttpHeaders
                {
                    ContentType = properties.Value.ContentType,
                    ContentLanguage = properties.Value.ContentLanguage,
                    ContentDisposition = properties.Value.ContentDisposition,
                    CacheControl = properties.Value.CacheControl,
                    ContentEncoding = properties.Value.ContentEncoding
                }
            },
            cancellationToken);

        return true;
    }
}
