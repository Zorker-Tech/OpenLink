/**
 * The seam that lets a caller watch ripgrep invocations.
 *
 * Nothing is recorded until a watcher is installed, and a watcher that throws cannot break the search that is being
 * recorded — an observation of the work must never change the work.
 */

/** A record of one ripgrep invocation: whatever the caller put in it. */
export interface RipgrepInvocationRecord { [key: string]: unknown }

/** The watcher that would receive invocations, or nothing while none is installed. */
let watcher: ((record: RipgrepInvocationRecord) => void) | undefined;

/** Whether anything is watching ripgrep invocations. */
export const isRipgrepInvocationRecordingEnabled = (): boolean => watcher !== undefined;

/** Hand one invocation to the watcher, when there is one; an observation must never break the work. */
export const recordRipgrepInvocation = (record: RipgrepInvocationRecord): void => {
  if (watcher === undefined) return;
  try { watcher(record); } catch {}
};
