/**
 * The release a plugin is installed from.
 *
 * A plugin's manifest can name a release of its own, and when it does not, the platform's fallback release
 * applies — which is how a plugin that only says "this is a plugin" is still installable. All three parts
 * have to be there for the release to be usable: a repository, an asset and a tag, since a release without
 * one of them cannot be fetched.
 */

export function getReleasePluginSource(
  fields: { releaseTag?: string; releaseRepo?: string; releaseAsset?: string },
  fallbackReleaseTag?: string,
): { kind: "release"; releaseRepo: string; releaseAsset: string; releaseTag: string } | undefined {
  const releaseTag = fields.releaseTag ?? fallbackReleaseTag
  return fields.releaseRepo && fields.releaseAsset && releaseTag
    ? { kind: "release", releaseRepo: fields.releaseRepo, releaseAsset: fields.releaseAsset, releaseTag }
    : undefined
}
