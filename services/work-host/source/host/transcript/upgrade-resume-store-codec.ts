import type { UpgradeResumeMarker } from "./upgrade-resume-store-contracts.ts"

export function coerceUpgradeResumeMarker(entry: unknown): UpgradeResumeMarker | null {
  if (typeof entry !== "object" || entry === null) return null
  const candidate = entry as Record<string, unknown>
  if (typeof candidate.agentId !== "string" || candidate.agentId.length === 0) return null

  return {
    agentId: candidate.agentId,
    markedAtMs: typeof candidate.markedAtMs === "number" && Number.isFinite(candidate.markedAtMs)
      ? candidate.markedAtMs
      : 0,
    ...(typeof candidate.source === "string" ? { source: candidate.source } : {}),
    ...(typeof candidate.automationId === "string" ? { automationId: candidate.automationId } : {}),
    ...(typeof candidate.automationRunId === "string" ? { automationRunId: candidate.automationRunId } : {}),
  }
}

export const coerceMarker2 = coerceUpgradeResumeMarker

export function parseUpgradeResumeFile(raw: string | null): UpgradeResumeMarker[] {
  if (raw === null) return []
  try {
    const value = JSON.parse(raw) as { pending?: unknown }
    if (typeof value !== "object" || value === null || !Array.isArray(value.pending)) return []
    return value.pending.flatMap((entry) => {
      const marker = coerceUpgradeResumeMarker(entry)
      return marker === null ? [] : [marker]
    })
  } catch {
    return []
  }
}

export function upsertResumeMarker(
  current: readonly UpgradeResumeMarker[],
  replacement: UpgradeResumeMarker,
): UpgradeResumeMarker[] {
  return [...current.filter((marker) => marker.agentId !== replacement.agentId), replacement]
}
