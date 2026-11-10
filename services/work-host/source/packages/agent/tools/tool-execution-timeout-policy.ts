export const LONG_RUNNING_TOOL_NAMES = new Set(["task", "mcp_task", "subagent"])
export const EXTRA_SHORT_TOOL_TIMEOUT_MS = 5 * 60 * 1_000
export const SHORT_TOOL_TIMEOUT_MS = 15 * 60 * 1_000
export const MEDIUM_TOOL_TIMEOUT_MS = 30 * 60 * 1_000
export const LONG_TOOL_TIMEOUT_MS = 60 * 60 * 1_000
export const EXTRA_LONG_TOOL_TIMEOUT_MS = 2 * 60 * 60 * 1_000
export const BACKGROUND_SHELL_DEFAULT_BLOCK_UNTIL_MS = 10 * 60 * 1_000

const REQUEST_BUFFER_MS = 60 * 1_000
const GUARD_HEADROOM_MS = 60 * 1_000
const BLOCK_GRACE_MS = 30 * 1_000

export const TOOL_CALL_TIMEOUT_TIERS_MS = [
  EXTRA_SHORT_TOOL_TIMEOUT_MS,
  SHORT_TOOL_TIMEOUT_MS,
  MEDIUM_TOOL_TIMEOUT_MS,
  LONG_TOOL_TIMEOUT_MS,
  EXTRA_LONG_TOOL_TIMEOUT_MS,
]

export function parseBlockUntilMs(args: unknown): number | undefined {
  let candidate = args
  if (typeof candidate === "string") {
    try {
      candidate = JSON.parse(candidate) as unknown
    } catch {
      return undefined
    }
  }
  if (typeof candidate !== "object" || candidate === null) return undefined
  const requestedMs = (candidate as Record<string, unknown>).block_until_ms
  return typeof requestedMs === "number" && Number.isFinite(requestedMs) && requestedMs >= 0
    ? requestedMs
    : undefined
}

export function isSubagentToolName(toolName: string): boolean {
  return LONG_RUNNING_TOOL_NAMES.has(toolName.toLowerCase())
}

export function suggestedToolTimeoutMs(toolName: string, args: unknown): number {
  if (isSubagentToolName(toolName)) return LONG_TOOL_TIMEOUT_MS
  const requestedMs = parseBlockUntilMs(args)
  return requestedMs === undefined ? SHORT_TOOL_TIMEOUT_MS : Math.max(0, requestedMs + REQUEST_BUFFER_MS)
}

export function pickToolCallTimeoutTierMs(suggestedMs: number): number {
  return TOOL_CALL_TIMEOUT_TIERS_MS.find((tierMs) => tierMs >= suggestedMs) ?? EXTRA_LONG_TOOL_TIMEOUT_MS
}

export function toolCallExecutionGuardMs(toolName: string, args: unknown): number {
  const selectedTierMs = pickToolCallTimeoutTierMs(suggestedToolTimeoutMs(toolName, args))
  const tierBoundaryMs = selectedTierMs - GUARD_HEADROOM_MS
  const requestedMs = parseBlockUntilMs(args)
  if (requestedMs === undefined) return tierBoundaryMs
  const guardMs = Math.max(tierBoundaryMs, requestedMs + BLOCK_GRACE_MS)
  return guardMs >= selectedTierMs ? tierBoundaryMs : guardMs
}
