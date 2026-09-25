/**
 * The seam that lets a caller watch ripgrep invocations.
 *
 * Nothing is recorded until a handler is installed, and a handler that throws cannot break the search that is being
 * recorded — an observation of the work must never change the work.
 */
export interface RipgrepInvocationRecord { [key: string]: unknown }
let handler: ((record: RipgrepInvocationRecord) => void) | undefined;
export function isRipgrepInvocationRecordingEnabled(): boolean { return handler !== undefined; }
export function recordRipgrepInvocation(record: RipgrepInvocationRecord): void {
  if (handler === undefined) return;
  try { handler(record); } catch {}
}
