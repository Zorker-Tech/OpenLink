/** Paths the counterpart model accepts for plan documents that have no on-disk file. */

export function planDocumentUri(agentId: string | undefined, filename: string): string {
  return agentId === undefined
    ? `slate-plan:///${filename}`
    : `slate-plan://${agentId}/${filename}`
}

export function unavailablePlanDocumentUri(): string {
  return "slate-plan://plan.md"
}
