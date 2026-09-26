/**
 * When the host drains its notifications.
 *
 * Notifications are drained on a poll, but some moments should not wait for the next one: work is owed, the connection
 * dropped, or something was recorded since the last poll and the floor has passed. The gate remembers what it has
 * drained so a recorded notification is not drained twice, and a poll with nothing new clears the flag.
 */
export const NOTIFY_SAFETY_POLL_MS = 120_000; export const NOTIFY_DRAIN_FLOOR_MS = 4_000;
export function createNotifyDrainGate(deps: { now(): number; isConnected?(): boolean; isSafetyPollEnabled?(): boolean }) { let notifyPending = false; let lastPollAtMs: number | null = null; let notifySeq = 0; let drainedNotifySeq = 0; return { recordNotify() { notifyPending = true; notifySeq += 1; }, shouldDrain(args: { hasOwedWork: boolean }): boolean { drainedNotifySeq = notifySeq; if (args.hasOwedWork) return true; if (!(deps.isConnected?.() ?? false)) return true; if (lastPollAtMs == null) return true; const since = deps.now() - lastPollAtMs; if (notifyPending && since >= NOTIFY_DRAIN_FLOOR_MS) return true; return (deps.isSafetyPollEnabled?.() ?? true) && since >= NOTIFY_SAFETY_POLL_MS; }, recordPoll() { if (notifySeq === drainedNotifySeq) notifyPending = false; lastPollAtMs = deps.now(); }, reset() { lastPollAtMs = null; } }; }
