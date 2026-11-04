import { latestHostBundleVersionUrl } from "./host-bundle-location.ts"

export const SHORT_GIT_SHA_REGEX = /^[0-9a-f]{7,40}$/
export const VERSION_CACHE_TTL_MS = 10 * 60_000

interface CachedVersion {
  readonly value: string
  readonly fetchedAt: number
}

let cachedVersion: CachedVersion | undefined

export function clearHostBundleVersionCache(): void {
  cachedVersion = undefined
}

export async function fetchLatestHostBundleVersion(fetchFn: typeof fetch = fetch): Promise<string | undefined> {
  if (
    cachedVersion !== undefined &&
    Date.now() - cachedVersion.fetchedAt < VERSION_CACHE_TTL_MS
  ) {
    return cachedVersion.value
  }

  try {
    const response = await fetchFn(latestHostBundleVersionUrl())
    if (!response.ok) return undefined

    const value = (await response.text()).trim()
    if (!SHORT_GIT_SHA_REGEX.test(value)) return undefined

    cachedVersion = { value, fetchedAt: Date.now() }
    return value
  } catch {
    return undefined
  }
}
