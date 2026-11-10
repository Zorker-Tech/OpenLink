import { hostBundleTarballUrl } from "./host-bundle-location.ts"
import { SlateHostBundleSourceError } from "./host-bundle-source-contracts.ts"
import { SHORT_GIT_SHA_REGEX } from "./host-bundle-version-catalog.ts"

export async function fetchHostBundleTarball(fetchFn: typeof fetch, version: string): Promise<Uint8Array> {
  if (!SHORT_GIT_SHA_REGEX.test(version)) {
    throw new SlateHostBundleSourceError(`slate host bundle: refusing malformed version "${version}"`)
  }

  const url = hostBundleTarballUrl(version)
  const response = await fetchFn(url)
  if (!response.ok) {
    throw new SlateHostBundleSourceError(`slate host bundle: fetch ${url} failed (status ${response.status})`)
  }

  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength === 0) {
    throw new SlateHostBundleSourceError(`slate host bundle: fetched empty tarball from ${url}`)
  }
  return bytes
}
