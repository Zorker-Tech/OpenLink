export type CodexReviewTarget =
  | { type: 'uncommittedChanges' }
  | { type: 'custom'; instructions: string }

/** Translate the user-visible `/review` command into Codex's native
 * `review/start` target. Ordinary prompt text must never be reclassified. */
export function codexReviewTarget(message: string): CodexReviewTarget | null {
  const match = /^\/review(?:\s+([\s\S]*?))?\s*$/i.exec(message)
  if (!match) return null
  const instructions = match[1]?.trim()
  return instructions
    ? { type: 'custom', instructions }
    : { type: 'uncommittedChanges' }
}
