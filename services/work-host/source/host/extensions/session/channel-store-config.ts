import { readFileSync } from "node:fs"
import { channelDisplayName } from "./channel-store-labels.ts"

export function readConfiguredChannelLabel(filePath: string): string | null {
  let source: string
  try {
    source = readFileSync(filePath, "utf8")
  } catch {
    return null
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(source) as unknown
  } catch {
    return null
  }
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) return null

  const label = (parsed as Record<string, unknown>).label
  return channelDisplayName(typeof label === "string" ? label : undefined)
}
