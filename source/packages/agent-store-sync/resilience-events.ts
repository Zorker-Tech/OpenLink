/**
 * What a sync client tells its caller about what went wrong.
 *
 * A disk that filled up, a symbolic link that was refused and a network that failed are three events a listener may
 * care about, and the listener that cares about none of them is the default.
 */

/** What a listener is asked about one event, and what it may answer with. */
type ListenerMethod = (event: unknown) => unknown;

/** A client's chance to hear about the things that can go wrong on a machine. */
export interface ResilienceListener {
  onDiskFull?: ListenerMethod;
  onSymlinkRefused?: ListenerMethod;
  onNetworkError?: ListenerMethod;
}

/** The listener that hears everything and does nothing, for callers that do not care. */
export const NOOP_RESILIENCE_LISTENER: Readonly<Required<ResilienceListener>> = Object.freeze({
  onDiskFull() {},
  onSymlinkRefused() {},
  onNetworkError() {},
});

/** A handler that only tells its promise what to do next; the notifier never waits for that promise. */
function noop(): void {}

/** A value a listener answered with that offers to be settled later. */
type Thenable<T> = { then(onFulfilled: (value: T) => void, onRejected: (error: unknown) => void): unknown };

/** Whether a listener's answer is a promise-like thing that has to be settled on its own. */
function isThenable(result: unknown): result is Thenable<unknown> {
  return result !== undefined && result !== null && typeof (result as { then?: unknown }).then === "function";
}

/** Let a promise a listener answered with settle on its own, so its rejection is not the notifier's. */
function settleQuietly(answered: Thenable<unknown>): void {
  answered.then(noop, noop);
}

/** Tell a listener about an event, when it asked to hear about that one. */
export function safeNotifyListener(listener: ResilienceListener | undefined, method: keyof ResilienceListener, event: unknown): void {
  if (listener === undefined) return;
  const handler = listener[method];
  if (typeof handler !== "function") return;
  let answered: unknown;
  try {
    answered = handler.call(listener, event);
  } catch {
    return;
  }
  if (isThenable(answered)) settleQuietly(answered);
}