/**
 * The release a plugin is installed from.
 *
 * A plugin's manifest can name a release of its own, and when it does not, the platform's fallback release
 * applies — which is how a plugin that only says "this is a plugin" is still installable. All three parts
 * have to be there for the release to be usable: a repository, an asset and a tag, since a release without
 * one of them cannot be fetched.
 */

interface ReleaseManifestFields {
  readonly releaseRepo?: string | undefined;
  readonly releaseAsset?: string | undefined;
  readonly releaseTag?: string | undefined;
}

interface ReleaseSource {
  readonly kind: "release";
  readonly releaseRepo: string;
  readonly releaseAsset: string;
  readonly releaseTag: string;
}

function completeReleaseSource(
  fields: ReleaseManifestFields,
): ReleaseSource | undefined {
  const { releaseRepo, releaseAsset, releaseTag } = fields;
  if (!releaseRepo || !releaseAsset || !releaseTag) return undefined;
  return { kind: "release", releaseRepo, releaseAsset, releaseTag };
}

export function releaseSourceFromManifest(
  manifest: ReleaseManifestFields,
  fallbackTag?: string,
): ReleaseSource | undefined {
  return completeReleaseSource({
    releaseRepo: manifest.releaseRepo,
    releaseAsset: manifest.releaseAsset,
    releaseTag: manifest.releaseTag ?? fallbackTag,
  });
}
