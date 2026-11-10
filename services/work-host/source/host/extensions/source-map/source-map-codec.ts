import type { SlateSourceEntry, SlateSourceMapValue } from "./source-map-contracts.ts"

const emptyMap = (): SlateSourceMapValue => Object.create(null) as SlateSourceMapValue

export function parseSlateSourceMap(value: unknown): SlateSourceMapValue {
  if (typeof value !== "object" || value == null || Array.isArray(value)) return emptyMap()

  const parsed = emptyMap()
  for (const [agentId, candidate] of Object.entries(value)) {
    if (typeof candidate !== "object" || candidate == null || Array.isArray(candidate)) continue
    const record = candidate as Record<string, unknown>
    if (
      typeof record.sourceId !== "string" || record.sourceId.length === 0
      || (record.mode !== "local" && record.mode !== "agent-store")
    ) continue
    parsed[agentId] = { sourceId: record.sourceId, mode: record.mode } as SlateSourceEntry
  }
  return parsed
}
