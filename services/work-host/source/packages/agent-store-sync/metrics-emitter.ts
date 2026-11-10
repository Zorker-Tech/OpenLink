/**
 * What a sync round reports about itself.
 *
 * A round counts what it pushed, pulled and skipped and how long it took, and the metrics are emitted under the names
 * the platform's telemetry uses, so a slow or busy store is visible without reading the logs.
 */

/** Everything a round counts about itself, plus what it failed with. */
interface RoundSummary {
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
  readonly errors: readonly unknown[];
  readonly walkMs?: number;
  readonly hashMs?: number;
  readonly presignMs?: number;
  readonly uploadMs?: number;
  readonly listMs?: number;
  readonly downloadMs?: number;
  readonly scope?: string;
}

/**
 * The counts the event carries under the same name the round keeps them, in the order the event lists them.
 *
 * One list, so a counter added to a round is a counter reported — the alternative is a field the round collects and
 * nobody can see.
 */
const REPORTED_AS_IS = [
  "durationMs",
  "filesPushed",
  "filesPulled",
  "filesSkipped",
  "bytesPushed",
  "bytesPulled",
  "refusals",
  "filesConflicted",
  "conflictProtectionDowngrades",
  "legacyProbes",
  "pushEntriesParked",
  "pullsDeferred",
  "filesDeletedRemote",
  "filesDeletedLocal",
  "deleteConflicts",
  "scanDeletesJournaled",
  "recoveryDisarms",
  "identityRecoveryWipeFailed",
  "legacyRowsRestored",
  "listingComplete",
] as const satisfies readonly (keyof RoundSummary)[];

/** The phases a round times; a phase that was not timed is reported as no time at all rather than left out. */
const TIMED_PHASES = ["walkMs", "hashMs", "presignMs", "uploadMs", "listMs", "downloadMs"] as const satisfies readonly (keyof RoundSummary)[];

/** The metrics a caller who wants none of them gets: every hook, doing nothing. */
const NOOP_HOOKS = [
  "onDiskFull",
  "onSymlinkRefused",
  "onNetworkError",
  "onRoundCompleted",
  "onRoundLifecycle",
  "onLockEvent",
  "onResumeDetected",
  "onDirtyPassiveStalled",
  "onError",
  "onConflict",
  "recordWriteBarrier",
  "tokenMinted",
  "tokenRefreshUnauthorized",
  "tokenMintNegativeCached",
  "tokenMintFailureCached",
] as const;

export const NOOP_METRICS_EMITTER = Object.freeze(Object.fromEntries(NOOP_HOOKS.map((hook) => [hook, () => {}])));

/** One round, as the telemetry reads it: every count, whether it failed, how long each phase took and what it covered. */
export function buildRoundCompletedEvent({ agentId, summary }: { readonly agentId: string; readonly summary: RoundSummary }): Record<string, unknown> {
  const event: Record<string, unknown> = { agentId };
  for (const count of REPORTED_AS_IS) event[count] = summary[count];
  event["errorCount"] = summary.errors.length;
  event["failed"] = summary.errors.length > 0;
  for (const phase of TIMED_PHASES) event[phase] = summary[phase] ?? 0;
  event["scope"] = summary.scope ?? "full";
  return event;
}
