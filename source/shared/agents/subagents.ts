/** The prefix the platform's own subagent ids carry, and how one is recognized. */
export const SLATE_SUBAGENT_ID_PREFIX = "slate-subagent-";

export function isSlateSubagentId(id: string): boolean {
  return id.startsWith(SLATE_SUBAGENT_ID_PREFIX);
}
