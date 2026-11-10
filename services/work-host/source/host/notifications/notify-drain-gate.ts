/**
 * When the host drains its notifications.
 *
 * Notifications are drained on a poll, but some moments should not wait for the next one: work is owed, the connection
 * dropped, or something was recorded since the last poll and the floor has passed. The gate remembers what it has
 * drained so a recorded notification is not drained twice, and a poll with nothing new clears the flag.
 */

/** How long the safety poll waits between drains when nothing asks for one sooner. */
export const NOTIFY_SAFETY_POLL_MS = 120_000;

/** The shortest wait a recorded notification drains after, once a poll has happened. */
export const NOTIFY_DRAIN_FLOOR_MS = 4_000;

/** What the gate asks of the host: its clock, and whether it is connected and its safety poll is on. */
type NotifyDrainDeps = {
  now(): number;
  isConnected?(): boolean;
  isSafetyPollEnabled?(): boolean;
};

/** A drain request the gate answers. */
type NotifyDrainArgs = {
  hasOwedWork: boolean;
};

/** A gate that decides whether the host should drain its notifications now. */
export function createNotifyDrainGate(deps: NotifyDrainDeps) {
  let notificationPending = false;
  let lastPollAtMs: number | null = null;
  let recordedSeq = 0;
  let drainedSeq = 0;

  /** Whether the host says it is connected; a host that says nothing is not. */
  const connected = (): boolean => deps.isConnected?.() ?? false;

  /** Whether the safety poll is on; a host that says nothing has it on. */
  const safetyPollEnabled = (): boolean => deps.isSafetyPollEnabled?.() ?? true;

  /** How long it has been since the last poll, or null when there has not been one. */
  const sinceLastPollMs = (): number | null => (lastPollAtMs == null ? null : deps.now() - lastPollAtMs);

  return {
    /** Something was recorded, so a drain may have something to do. */
    recordNotify(): void {
      notificationPending = true;
      recordedSeq += 1;
    },

    /** Whether the host should drain now. */
    shouldDrain({ hasOwedWork }: NotifyDrainArgs): boolean {
      drainedSeq = recordedSeq;
      if (hasOwedWork) return true;
      if (!connected()) return true;
      const since = sinceLastPollMs();
      if (since === null) return true;
      if (notificationPending && since >= NOTIFY_DRAIN_FLOOR_MS) return true;
      return safetyPollEnabled() && since >= NOTIFY_SAFETY_POLL_MS;
    },

    /** A poll happened: a notification that was already drained is cleared. */
    recordPoll(): void {
      if (recordedSeq === drainedSeq) notificationPending = false;
      lastPollAtMs = deps.now();
    },

    /** A new connection: the first drain after it does not wait for a poll. */
    reset(): void {
      lastPollAtMs = null;
    },
  };
}
