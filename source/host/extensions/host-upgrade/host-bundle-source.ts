import type { HostBundleSource } from "./host-bundle-source-contracts.ts"
import { fetchHostBundleTarball } from "./host-bundle-download.ts"
import { fetchLatestHostBundleVersion } from "./host-bundle-version-catalog.ts"

export { fetchHostBundleTarball } from "./host-bundle-download.ts"
export {
  DEFAULT_BASE_URL,
  HOST_BUNDLE_BUCKET,
  HOST_BUNDLE_PREFIX,
  HOST_BUNDLE_REGION,
  hostBundleBaseUrl,
  hostBundleTarballUrl,
  latestHostBundleVersionUrl,
  LATEST_VERSION_FILE,
} from "./host-bundle-location.ts"
export { fetchLatestHostBundleVersion, clearHostBundleVersionCache, SHORT_GIT_SHA_REGEX, VERSION_CACHE_TTL_MS } from "./host-bundle-version-catalog.ts"
export { SlateHostBundleSourceError } from "./host-bundle-source-contracts.ts"
export type { HostBundleSource } from "./host-bundle-source-contracts.ts"

export async function resolveHostBundleSource(fetchFn: typeof fetch = fetch): Promise<HostBundleSource | undefined> {
  const version = await fetchLatestHostBundleVersion(fetchFn)
  if (version === undefined) return undefined

  return {
    version,
    loadBundleBytes: () => fetchHostBundleTarball(fetchFn, version),
  }
}
