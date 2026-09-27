/**
 * What a sync client tells its caller about what went wrong.
 *
 * A disk that filled up, a symbolic link that was refused and a network that failed are three events a listener may
 * care about, and the listener that cares about none of them is the default.
 */
export interface ResilienceListener {
  onDiskFull?(event: unknown): unknown;
  onSymlinkRefused?(event: unknown): unknown;
  onNetworkError?(event: unknown): unknown;
}
export const NOOP_RESILIENCE_LISTENER: Readonly<Required<ResilienceListener>> = Object.freeze({ onDiskFull() {}, onSymlinkRefused() {}, onNetworkError() {} });
function noop(): void {}
export function safeNotifyListener(listener: ResilienceListener | undefined, method: keyof ResilienceListener, event: unknown): void {
  if (listener === undefined) return;
  const handler = listener[method];
  if (typeof handler !== "function") return;
  let result: unknown;
  try { result = handler.call(listener, event); } catch { return; }
  if (result !== undefined && result !== null && typeof (result as { then?: unknown }).then === "function") {
    (result as { then(onFulfilled: () => void, onRejected: () => void): unknown }).then(noop, noop);
  }
}
