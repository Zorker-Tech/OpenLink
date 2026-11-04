export function normalizeDestinationHost(value: string): string | undefined {
  const normalized = value.trim().toLowerCase()
  if (normalized.length === 0) return undefined

  try {
    const address = normalized.includes("://") ? normalized : `https://${normalized}`
    const host = new URL(address).hostname.replace(/^www\./, "")
    return host || undefined
  } catch {
    return undefined
  }
}
