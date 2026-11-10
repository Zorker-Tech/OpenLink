import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

/** Parse valid rows independently so one damaged record does not discard the rest of the file. */
export function parseDedupeFile(raw: string | null): Map<string, number> {
  if (raw === null) return new Map()

  let decoded: unknown
  try {
    decoded = JSON.parse(raw)
  } catch {
    return new Map()
  }

  const entries = typeof decoded === "object" && decoded !== null
    ? (decoded as { readonly seen?: unknown }).seen
    : undefined
  if (!Array.isArray(entries)) return new Map()

  const values = new Map<string, number>()
  for (const candidate of entries) {
    if (typeof candidate !== "object" || candidate === null) continue
    const item = candidate as Record<string, unknown>
    if (typeof item.nonce !== "string" || item.nonce.length === 0) continue
    if (typeof item.expiresAtMs !== "number" || !Number.isFinite(item.expiresAtMs)) continue
    values.set(item.nonce, item.expiresAtMs)
  }
  return values
}

export function readDedupeFile(filePath: string): Map<string, number> {
  try {
    return parseDedupeFile(readFileSync(filePath, "utf8"))
  } catch {
    return parseDedupeFile(null)
  }
}

/** Replace the previous snapshot from a sibling file; disk trouble leaves the live map usable in memory. */
export function persistDedupeFile(filePath: string, values: ReadonlyMap<string, number>): void {
  const temporaryPath = `${filePath}.part`
  const payload = JSON.stringify({
    version: 1,
    seen: [...values].map(([nonce, expiresAtMs]) => ({ nonce, expiresAtMs })),
  })
  try {
    mkdirSync(dirname(filePath), { recursive: true })
    writeFileSync(temporaryPath, payload)
    renameSync(temporaryPath, filePath)
  } catch {
    // A later process can retry persistence; this process still has the updated nonce map.
  }
}
