/** Transcript consistency helpers and best-effort legacy directory cleanup. */
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { rebuildTranscriptEntriesFromState, type OutlineItem } from "./conversation-recovery.ts";
import { sameRecoveredTranscriptEntry } from "./session-recovery.ts";
import type { MaintenanceDb, MaintenanceHost } from "./session-maintenance-contracts.ts";

type TranscriptOutline = { turns: readonly { items: readonly OutlineItem[] }[] };
type TranscriptBackfillInput = TranscriptOutline | readonly Record<string, unknown>[];

export function backfillTranscript(
  _host: unknown,
  database: Pick<MaintenanceDb, "getTranscriptEntries" | "appendTranscriptEntries">,
  source: TranscriptBackfillInput,
): number {
  const rebuilt = Array.isArray(source) ? source : rebuildTranscriptEntriesFromState(source as TranscriptOutline);
  const stored = database.getTranscriptEntries();
  if (stored.length >= rebuilt.length) return 0;

  const prefixMatches = stored.every((row, index) => {
    const recovered = rebuilt[index];
    return recovered !== undefined && sameRecoveredTranscriptEntry(row, recovered as Record<string, unknown>);
  });
  if (!prefixMatches) return 0;

  const missing = rebuilt.slice(stored.length) as Array<Record<string, unknown> & { id: string; kind: string }>;
  const result = database.appendTranscriptEntries(missing);
  if (typeof result === "number") return result;
  return result ? missing.length : 0;
}

export async function cleanupLegacyGroupMemberDirs(
  host: Pick<MaintenanceHost, "rootDir" | "report">,
  dirnameToRemove = "members",
): Promise<void> {
  let agents;
  try {
    agents = await readdir(host.rootDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const agent of agents) {
    if (!agent.isDirectory()) continue;
    try {
      await rm(join(host.rootDir, agent.name, dirnameToRemove), { recursive: true, force: true });
    } catch (error) {
      host.report?.({
        family: "maintenance",
        kind: "member_cleanup_failed",
        agentId: agent.name,
        errorClass: error instanceof Error ? error.name : String(error),
      });
    }
  }
}

export async function runSessionMaintenance(
  tasks: readonly (() => void | Promise<void>)[],
  report: (error: unknown, index: number) => void = () => {},
): Promise<void> {
  for (const [index, task] of tasks.entries()) {
    try {
      await task();
    } catch (error) {
      report(error, index);
    }
  }
}
