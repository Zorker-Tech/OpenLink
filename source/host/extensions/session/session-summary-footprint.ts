import { readdir } from "node:fs/promises";

/** A quarantined database is durable evidence that this agent must remain visible for recovery. */
export async function agentHasQuarantinedStoreDb(directory: string): Promise<boolean> {
  try {
    const names = await readdir(directory);
    return names.some((name) => name.startsWith("store.db.corrupt-"));
  } catch {
    return false;
  }
}

/** Check durable sources in order, stopping at the first one that can keep a summary. */
export async function agentHasDurableFootprint(
  directory: string,
  memoryExistsAt: (path: string) => boolean,
  automationExistsAt: (path: string) => boolean = () => false,
  workflowExistsAt: (path: string) => boolean = () => false,
): Promise<boolean> {
  if (await agentHasQuarantinedStoreDb(directory)) return true;
  if (memoryExistsAt(directory)) return true;
  if (automationExistsAt(directory)) return true;
  return workflowExistsAt(directory);
}
