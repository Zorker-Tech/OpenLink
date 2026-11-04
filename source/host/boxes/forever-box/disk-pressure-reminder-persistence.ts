import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export class SlateDiskPressureLedgerError extends Error {}

export interface DiskPressureReminderLedgerState {
  readonly activeEpisodeId: string | null;
  readonly handledAgentIds: ReadonlySet<string>;
  readonly pendingEpisodeIds: ReadonlyMap<string, readonly string[]>;
}

export interface RestoredDiskPressureReminderLedger {
  readonly activeEpisodeId: string | null;
  readonly handledAgentIds: Set<string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}

/** Read only valid ledger entries, retaining no partially parsed state after a malformed file. */
export function restoreDiskPressureReminderLedger(args: {
  readonly filePath: string | undefined;
  readonly enqueue: (agentId: string, episodeId: string) => boolean;
  readonly onLedgerError: ((error: unknown) => void) | undefined;
}): RestoredDiskPressureReminderLedger {
  let activeEpisodeId: string | null = null;
  const handledAgentIds = new Set<string>();
  if (args.filePath === undefined) return { activeEpisodeId, handledAgentIds };

  try {
    const parsed: unknown = JSON.parse(readFileSync(args.filePath, "utf8"));
    if (!isRecord(parsed) || parsed.version !== 1) {
      throw new SlateDiskPressureLedgerError("invalid disk-pressure reminder ledger");
    }
    activeEpisodeId = typeof parsed.activeEpisodeId === "string" ? parsed.activeEpisodeId : null;
    if (activeEpisodeId !== null && Array.isArray(parsed.handledAgentIds)) {
      for (const agentId of parsed.handledAgentIds) {
        if (typeof agentId === "string") handledAgentIds.add(agentId);
      }
    }
    if (Array.isArray(parsed.pending)) {
      for (const item of parsed.pending) {
        if (isRecord(item) && typeof item.agentId === "string" && typeof item.episodeId === "string") {
          args.enqueue(item.agentId, item.episodeId);
        }
      }
    }
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) args.onLedgerError?.(error);
    activeEpisodeId = null;
    handledAgentIds.clear();
  }

  return { activeEpisodeId, handledAgentIds };
}

/** Replace the persisted snapshot atomically, or remove an empty ledger. */
export function persistDiskPressureReminderLedger(args: {
  readonly filePath: string | undefined;
  readonly state: DiskPressureReminderLedgerState;
  readonly onLedgerError: ((error: unknown) => void) | undefined;
}): boolean {
  if (args.filePath === undefined) return true;

  try {
    if (args.state.activeEpisodeId === null && args.state.pendingEpisodeIds.size === 0) {
      rmSync(args.filePath, { force: true });
      return true;
    }

    const ledger = {
      version: 1,
      activeEpisodeId: args.state.activeEpisodeId,
      handledAgentIds: args.state.activeEpisodeId === null ? [] : [...args.state.handledAgentIds],
      pending: [...args.state.pendingEpisodeIds].flatMap(([agentId, episodeIds]) =>
        episodeIds.map((episodeId) => ({ agentId, episodeId }))),
    };
    mkdirSync(dirname(args.filePath), { recursive: true });
    writeFileSync(`${args.filePath}.part`, JSON.stringify(ledger));
    renameSync(`${args.filePath}.part`, args.filePath);
    return true;
  } catch (error) {
    args.onLedgerError?.(error);
    return false;
  }
}
