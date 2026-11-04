/** Paths the counterpart model accepts for plan documents that have no on-disk file. */

export function planDocumentUri(counterpartAgentId: string | undefined, filename: string): string {
  return counterpartAgentId === undefined
    ? `cursor-plan:///${filename}`
    : `cursor-plan://${counterpartAgentId}/${filename}`
}

export function unavailablePlanDocumentUri(): string {
  return "cursor-plan://plan.md"
}
