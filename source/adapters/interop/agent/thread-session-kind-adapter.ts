import type { ThreadSessionKind } from "../../../packages/agent/prompts/thread-bound-session.ts"

/** Project the external named-session value into the small category Slate's prompt policy needs. */
export function projectThreadSessionKind(value: unknown): ThreadSessionKind | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== "string") return "other"
  const sessionKind = value.trim()
  if (sessionKind.length === 0) return undefined
  return sessionKind === "slack_thread" ? "thread" : "other"
}
