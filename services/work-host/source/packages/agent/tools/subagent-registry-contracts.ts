export interface SubagentHandle {
  cancel(reason?: unknown): void
}

export interface SubagentEntry {
  readonly id: string
  readonly handle: SubagentHandle
}

export function excludedSubagentCalls(options: unknown): ReadonlySet<string> {
  if (options == null || typeof options !== "object" || Array.isArray(options)) return new Set()
  const candidate = (options as Record<string, unknown>).excludeToolCallIds
  if (!Array.isArray(candidate)) return new Set()
  return new Set(candidate.filter((value): value is string => typeof value === "string"))
}
