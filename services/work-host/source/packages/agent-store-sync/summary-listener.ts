/**
 * Watching what the store says about a set of paths.
 *
 * The summaries the store answers with are turned into the events the sync round reports — what completed, what
 * changed — and a summary whose digest does not match the one expected is reported as a change rather than trusted.
 */
import { createHash } from "node:crypto";
import { classifyAgentStoreSourceId } from "./paths.ts";
import { buildRoundCompletedEvent } from "./metrics-emitter.ts";
import { safeNotifyListener, type ResilienceListener } from "./resilience-events.ts";

/** The digest a path is hashed with. */
const HASH_ALGORITHM = "sha256";

/** What separates the salt from the path in a digest, so neither can be read out of the other's hash. */
const HASH_SEPARATOR = "\0";

/** What a path is hashed as when the summary did not carry one. */
const UNKNOWN_REL_PATH = "<unknown>";

/** How much of the hex digest a path hash keeps. */
const HASH_HEX_LENGTH = 32;

/** The failure a symlink-refused notification is not sent without. */
const MISSING_PATH_HASH_SALT = "notifySummaryResult: pathHashSalt is required when emitting symlink-refused events";

/** The failures that mean a path was refused because something on the way is a symlink. */
const SYMLINK_REFUSAL_CODES: ReadonlySet<string> = new Set(["symlink_refused", "toctou_swap_refused"]);

/** The failures that mean the disk would not take or give the bytes. */
const DISK_FULL_CODES: ReadonlySet<string> = new Set(["fs_write_failed", "fs_read_failed"]);

/** The operation each failure code is reported under. */
const OP_BY_CODE: ReadonlyMap<string, string> = new Map([
  ["symlink_refused", "fs_read"],
  ["toctou_swap_refused", "fs_read"],
  ["fs_read_failed", "fs_read"],
  ["fs_write_failed", "fs_write"],
  ["upload_failed", "blob_put"],
  ["write_conflict", "blob_put"],
  ["delete_failed", "delete_files"],
  ["download_failed", "blob_get"],
]);

/** One failure a summary carries. */
interface SummaryFailure {
  readonly code: string;
  readonly relPath?: string | undefined;
  readonly timeoutClass?: string | undefined;
}

/** One conflict a summary carries: the path, and the path it conflicted with. */
interface SummaryConflict {
  readonly relPath: string;
  readonly conflictRelPath: string;
}

/** What one sync round reports about the paths it looked at. */
interface SyncSummary {
  readonly durationMs: number;
  readonly filesPushed: number;
  readonly filesPulled: number;
  readonly filesSkipped: number;
  readonly bytesPushed: number;
  readonly bytesPulled: number;
  readonly refusals: number;
  readonly filesConflicted: number;
  readonly conflictProtectionDowngrades: number;
  readonly legacyProbes: number;
  readonly pushEntriesParked: number;
  readonly pullsDeferred: number;
  readonly filesDeletedRemote: number;
  readonly filesDeletedLocal: number;
  readonly deleteConflicts: number;
  readonly scanDeletesJournaled: number;
  readonly recoveryDisarms: number;
  readonly identityRecoveryWipeFailed: number;
  readonly legacyRowsRestored: number;
  readonly listingComplete: boolean;
  readonly errors: readonly SummaryFailure[];
  readonly conflicts: readonly SummaryConflict[];
  readonly walkMs?: number | undefined;
  readonly hashMs?: number | undefined;
  readonly presignMs?: number | undefined;
  readonly uploadMs?: number | undefined;
  readonly listMs?: number | undefined;
  readonly downloadMs?: number | undefined;
  readonly scope?: string | undefined;
}

/** The listener a sync round reports its failures and events to. */
interface SyncRoundListener extends ResilienceListener {
  readonly onRoundCompleted?: ((event: unknown) => unknown) | undefined;
  readonly onError?: ((event: unknown) => unknown) | undefined;
  readonly onConflict?: ((event: unknown) => unknown) | undefined;
}

/** Runs each action even when one fails, and throws the first failure once they have all run. */
function runEachKeepingFirstFailure(actions: readonly (() => void)[]): void {
  let firstFailure: unknown;
  for (const action of actions) {
    try {
      action();
    } catch (err) {
      if (firstFailure === undefined) {
        firstFailure = err;
      }
    }
  }
  if (firstFailure !== undefined) {
    throw firstFailure;
  }
}

/** The hash a path is reported under: salted, truncated, and never the path itself. */
function hashRelPath({ relPath, salt }: { readonly relPath?: string | undefined; readonly salt: string }): string {
  return createHash(HASH_ALGORITHM)
    .update(salt)
    .update(HASH_SEPARATOR)
    .update(relPath ?? UNKNOWN_REL_PATH)
    .digest("hex")
    .slice(0, HASH_HEX_LENGTH);
}

/** The salt a symlink-refused notification needs, refusing to notify without one. */
function requirePathHashSalt(pathHashSalt: string | undefined): string {
  if (pathHashSalt === undefined || pathHashSalt.length === 0) {
    throw new Error(MISSING_PATH_HASH_SALT);
  }
  return pathHashSalt;
}

/** Reports one summary failure to the listener, as a symlink refusal or as a full disk. */
function dispatchSummaryFailure({
  agentId,
  failure,
  listener,
  pathHashSalt,
}: {
  readonly agentId: string;
  readonly failure: SummaryFailure;
  readonly listener: SyncRoundListener;
  readonly pathHashSalt?: string | undefined;
}): void {
  if (SYMLINK_REFUSAL_CODES.has(failure.code)) {
    safeNotifyListener(listener, "onSymlinkRefused", {
      agentId,
      op: "fs_read",
      relPathHash: hashRelPath({
        relPath: failure.relPath,
        salt: requirePathHashSalt(pathHashSalt),
      }),
    });
    return;
  }
  if (DISK_FULL_CODES.has(failure.code)) {
    safeNotifyListener(listener, "onDiskFull", {
      agentId,
      op: failure.code === "fs_read_failed" ? "fs_read" : "fs_write",
    });
  }
}

/** Reports the failures of a summary to its listener, throwing the first failure that reporting raised. */
export function notifySummaryResult({
  agentId: conversationAgentId,
  summary: round,
  listener: watcher,
  pathHashSalt: salt,
}: {
  readonly agentId: string;
  readonly summary: SyncSummary;
  readonly listener?: SyncRoundListener | undefined;
  readonly pathHashSalt?: string | undefined;
}): void {
  if (watcher === undefined) {
    return;
  }
  runEachKeepingFirstFailure(round.errors.map((failure) => () => dispatchSummaryFailure({
    agentId: conversationAgentId,
    failure,
    listener: watcher,
    pathHashSalt: salt,
  })));
}

/** The summary a round-completed event carries: its counts, its failures and the times it kept. */
function roundSummaryOf(round: SyncSummary): Parameters<typeof buildRoundCompletedEvent>[0]["summary"] {
  const walkMs = round.walkMs;
  const hashMs = round.hashMs;
  const presignMs = round.presignMs;
  const uploadMs = round.uploadMs;
  const listMs = round.listMs;
  const downloadMs = round.downloadMs;
  const scope = round.scope;
  return {
    durationMs: round.durationMs,
    filesPushed: round.filesPushed,
    filesPulled: round.filesPulled,
    filesSkipped: round.filesSkipped,
    bytesPushed: round.bytesPushed,
    bytesPulled: round.bytesPulled,
    refusals: round.refusals,
    filesConflicted: round.filesConflicted,
    conflictProtectionDowngrades: round.conflictProtectionDowngrades,
    legacyProbes: round.legacyProbes,
    pushEntriesParked: round.pushEntriesParked,
    pullsDeferred: round.pullsDeferred,
    filesDeletedRemote: round.filesDeletedRemote,
    filesDeletedLocal: round.filesDeletedLocal,
    deleteConflicts: round.deleteConflicts,
    scanDeletesJournaled: round.scanDeletesJournaled,
    recoveryDisarms: round.recoveryDisarms,
    identityRecoveryWipeFailed: round.identityRecoveryWipeFailed,
    legacyRowsRestored: round.legacyRowsRestored,
    listingComplete: round.listingComplete,
    errors: round.errors,
    ...(walkMs === undefined ? {} : { walkMs }),
    ...(hashMs === undefined ? {} : { hashMs }),
    ...(presignMs === undefined ? {} : { presignMs }),
    ...(uploadMs === undefined ? {} : { uploadMs }),
    ...(listMs === undefined ? {} : { listMs }),
    ...(downloadMs === undefined ? {} : { downloadMs }),
    ...(scope === undefined ? {} : { scope }),
  };
}

/** The error event one summary failure is reported as. */
function errorEventOf(
  agentId: string,
  failure: SummaryFailure,
  metricsSalt: string | undefined,
): Record<string, unknown> {
  return {
    agentId,
    op: opForCode(failure.code),
    errorClass: failure.code,
    relPathHash: failure.relPath === undefined || metricsSalt === undefined
      ? undefined
      : hashRelPath({ relPath: failure.relPath, salt: metricsSalt }),
    ...(failure.timeoutClass === undefined ? {} : { timeoutClass: failure.timeoutClass }),
  };
}

/** The conflict event one summary conflict is reported as. */
function conflictEventOf(
  agentId: string,
  storeKind: string,
  conflict: SummaryConflict,
  metricsSalt: string | undefined,
): Record<string, unknown> {
  return {
    agentId,
    storeKind,
    relPathHash: metricsSalt === undefined ? undefined : hashRelPath({ relPath: conflict.relPath, salt: metricsSalt }),
    conflictRelPathHash: metricsSalt === undefined ? undefined : hashRelPath({
      relPath: conflict.conflictRelPath,
      salt: metricsSalt,
    }),
  };
}

/** Reports a summary's metrics and failures to the emitter, throwing the first reporting failure once all are reported. */
export function notifySummaryMetrics({
  agentId: conversationAgentId,
  summary: round,
  listener: watcher,
  metricsEmitter: emitter,
  pathHashSalt: salt,
}: {
  readonly agentId: string;
  readonly summary: SyncSummary;
  readonly listener?: SyncRoundListener | undefined;
  readonly metricsEmitter?: SyncRoundListener | undefined;
  readonly pathHashSalt?: string | undefined;
}): void {
  runEachKeepingFirstFailure([
    () => {
      if (emitter !== undefined) {
        emitSummaryMetrics({ agentId: conversationAgentId, summary: round, metricsEmitter: emitter, pathHashSalt: salt });
      }
    },
    () => notifySummaryResult({ agentId: conversationAgentId, summary: round, listener: watcher, pathHashSalt: salt }),
  ]);
}

/** The metrics one round emits: its completion, one event per failure, one per conflict. */
function emitSummaryMetrics({
  agentId,
  summary: round,
  metricsEmitter: emitter,
  pathHashSalt: salt,
}: {
  readonly agentId: string;
  readonly summary: SyncSummary;
  readonly metricsEmitter: SyncRoundListener;
  readonly pathHashSalt?: string | undefined;
}): void {
  let firstFailure: unknown;
  const recordFailure = (err: unknown): void => {
    if (firstFailure === undefined) {
      firstFailure = err;
    }
  };
  try {
    emitter.onRoundCompleted?.(buildRoundCompletedEvent({ agentId, summary: roundSummaryOf(round) }));
  } catch (err) {
    recordFailure(err);
  }
  const metricsSalt = salt !== undefined && salt.length > 0 ? salt : undefined;
  if (emitter.onError !== undefined) {
    for (const failure of round.errors) {
      try {
        emitter.onError(errorEventOf(agentId, failure, metricsSalt));
      } catch (err) {
        recordFailure(err);
      }
    }
  }
  if (emitter.onConflict !== undefined && round.conflicts.length > 0) {
    const storeKind = classifyAgentStoreSourceId(agentId);
    for (const conflict of round.conflicts) {
      try {
        emitter.onConflict(conflictEventOf(agentId, storeKind, conflict, metricsSalt));
      } catch (err) {
        recordFailure(err);
      }
    }
  }
  if (firstFailure !== undefined) {
    throw firstFailure;
  }
}

/** The operation a failure code is reported under, or "unknown" for a code this round does not know. */
function opForCode(code: string): string {
  return OP_BY_CODE.get(code) ?? "unknown";
}