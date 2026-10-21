/**
 * The scheduling vocabulary the platform shares: the deadline that was exceeded, and the policies a wait follows.
 *
 * Every policy here is the same three things in different clothes, and the file is organised around that:
 *
 * - **an option is checked once, the same way** — a policy with a blank name or a delay that is not a finite
 *   non-negative number refuses to be built, and says which option was wrong;
 * - **a wait is a timer plus a way to cancel it** — `createDelay` owns "resolve on the timer, reject on the signal, and
 *   leave nothing behind either way", so no policy has to hold the listener bookkeeping itself;
 * - **a cancellation is not an error the caller wrote** — an aborted wait rejects with the signal's own reason (or a
 *   well-formed `AbortError`), which is what lets a caller tell "it was cancelled" from "it failed".
 *
 * The policies themselves are small on purpose: a poller is "tick, then wait, then tick again unless disposed"; a retry is
 * "work, then wait, then work again while the attempts last and the error is retryable"; a deadline is "work with a signal
 * that gets aborted when the timer fires".
 */

export class DeadlineExceededError extends Error {
  readonly code = "deadline_exceeded";

  constructor(readonly policyName: string) {
    super(`Deadline exceeded for ${policyName}`);
    this.name = "DeadlineExceededError";
  }
}

export interface Clock {
  now(): number;
  monotonicNow(): number;
  schedule(delayMs: number, callback: () => void): { dispose(): void };
}

export const realClock: Clock = {
  now: () => Date.now(),
  monotonicNow: () => performance.now(),
  schedule(delayMs, callback) {
    requireDelay(delayMs, "delayMs");
    let active = true;
    const timer = setTimeout(() => {
      if (!active) return;
      active = false;
      callback();
    }, delayMs);
    timer.unref?.();
    return {
      dispose() {
        if (!active) return;
        active = false;
        clearTimeout(timer);
      },
    };
  },
};

export interface DeadlinePolicy {
  readonly name: string;
  run<T>(work: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T>;
}

export interface ExpiryPolicy {
  readonly name: string;
  arm(key: string, onExpire: () => void): { dispose(): void };
}

export interface PollingPolicy {
  readonly name: string;
  start(tick: () => Promise<void>, signal?: AbortSignal): { dispose(): void };
}

export interface RetryPolicy {
  readonly name: string;
  schedule(attempt: number, signal?: AbortSignal): { readonly elapsed: Promise<void>; dispose(): void };
  runWithRetry<T>(work: (attempt: number, signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T>;
}

export interface IdleWatchdogPolicy {
  readonly name: string;
  arm(onIdle: () => void): { kick(): void; dispose(): void };
}

export interface DebouncePolicy {
  readonly name: string;
  wrap<Args extends unknown[]>(fn: (...args: Args) => void): ((...args: Args) => void) & { dispose(): void };
}

/** The options a policy refuses: a blank name and a delay that is not a finite non-negative number. */
function requireName(name: string): void {
  if (name.trim().length === 0) throw new TypeError("name must not be empty");
}

function requireDelay(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${label} must be a finite non-negative number`);
}

function requireAttemptNumber(value: number): void {
  if (!Number.isInteger(value) || value < 1) throw new RangeError("attempt must be a positive integer");
}

function createAbortError(): Error {
  const error = new Error("Operation aborted");
  error.name = "AbortError";
  return error;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("This operation was aborted", "AbortError");
}

/** The signal's reason when it has one, so a cancellation arrives as what caused it. */
function abortErrorFor(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("This operation was aborted", "AbortError");
}

/** One listener, added once and removed once: the whole of what a policy needs to follow a caller's signal. */
function followSignal(signal: AbortSignal | undefined, onAbort: () => void): { dispose(): void } {
  if (signal == null) return { dispose: () => {} };
  if (signal.aborted) {
    onAbort();
    return { dispose: () => {} };
  }
  signal.addEventListener("abort", onAbort, { once: true });
  return { dispose: () => signal.removeEventListener("abort", onAbort) };
}

/** A promise that only rejects, with the signal's reason, and whose rejection is handled even if nobody races it. */
function cancellationOf(signal: AbortSignal | undefined): { readonly rejected: Promise<never>; readonly reject: (error: unknown) => void; readonly dispose: () => void } {
  let reject: (error: unknown) => void = () => {};
  const rejected = new Promise<never>((_resolve, fail) => {
    reject = fail;
  });
  void rejected.catch(() => {});
  const link = signal == null ? { dispose: () => {} } : followSignal(signal, () => reject(abortErrorFor(signal)));
  return { rejected, reject: (error) => reject(error), dispose: () => link.dispose() };
}

/** A timer that is replaced every time it is armed again: a debounce and the idle watchdog are both this. */
function rearmingTimer(clock: Clock, delayMs: number, fire: () => void) {
  let scheduled: { dispose(): void } | undefined;
  return {
    arm(): void {
      scheduled?.dispose();
      scheduled = clock.schedule(delayMs, () => {
        scheduled = undefined;
        fire();
      });
    },
    stop(): void {
      scheduled?.dispose();
      scheduled = undefined;
    },
  };
}

/**
 * A wait that can be cancelled from either side: the timer resolves it, the signal rejects it, and `dispose` gives the
 * caller a cancellation of its own. Whichever happens first wins, and the other one is disarmed.
 */
function createDelay(clock: Clock, delayMs: number, signal?: AbortSignal) {
  const { promise: elapsed, resolve, reject } = Promise.withResolvers<void>();
  void elapsed.catch(() => {});
  let settled = false;
  let link: { dispose(): void } | undefined;
  const settle = (error?: unknown): void => {
    if (settled) return;
    settled = true;
    scheduled.dispose();
    link?.dispose();
    if (error === undefined) resolve();
    else reject(error);
  };
  const scheduled = clock.schedule(delayMs, () => settle());
  link = followSignal(signal, () => settle(abortErrorFor(signal!)));
  return { elapsed, dispose: () => settle(createAbortError()) };
}

/** A delay that doubles per attempt, bounded by the policy's ceiling. */
function backoffFor(attempt: number, initialDelayMs: number, maxDelayMs: number, factor: number): number {
  const growth = Math.min(factor ** (attempt - 1), Number.MAX_VALUE);
  return Math.min(maxDelayMs, initialDelayMs * growth);
}

export function createDebouncePolicy(clock: Clock, options: { name: string; delayMs: number }): DebouncePolicy {
  requireName(options.name);
  requireDelay(options.delayMs, "delayMs");
  return {
    name: options.name,
    wrap<Args extends unknown[]>(fn: (...args: Args) => void) {
      let active = true;
      // The most recent call is the one that fires: that is what makes this a debounce rather than a delay.
      let latest = [] as unknown as Args;
      const timer = rearmingTimer(clock, options.delayMs, () => fn(...latest));
      return Object.assign(
        (...next: Args) => {
          if (!active) return;
          latest = next;
          timer.arm();
        },
        {
          dispose() {
            if (!active) return;
            active = false;
            timer.stop();
          },
        },
      );
    },
  };
}

export function createRealDebouncePolicy(options: { name: string; delayMs: number }): DebouncePolicy {
  return createDebouncePolicy(realClock, options);
}

export function createRetryPolicy(
  clock: Clock,
  options: {
    name: string;
    maxAttempts: number;
    initialDelayMs: number;
    maxDelayMs: number;
    backoffFactor?: number;
    shouldRetry?: (error: unknown, attempt: number) => boolean;
  },
): RetryPolicy {
  requireName(options.name);
  if (!Number.isInteger(options.maxAttempts) || options.maxAttempts < 1) throw new RangeError("maxAttempts must be a positive integer");
  requireDelay(options.initialDelayMs, "initialDelayMs");
  requireDelay(options.maxDelayMs, "maxDelayMs");
  if (options.maxDelayMs < options.initialDelayMs) throw new RangeError("maxDelayMs must be at least initialDelayMs");
  const backoffFactor = options.backoffFactor ?? 2;
  if (!Number.isFinite(backoffFactor) || backoffFactor < 1) throw new RangeError("backoffFactor must be a finite number at least 1");
  const shouldRetry = options.shouldRetry ?? (() => true);
  // A retry that is not given a signal still hands its work one, so the work never has to special-case "no cancellation".
  const noSignal = new AbortController();
  const policy: RetryPolicy = {
    name: options.name,
    schedule(attempt, signal) {
      requireAttemptNumber(attempt);
      return createDelay(clock, backoffFor(attempt, options.initialDelayMs, options.maxDelayMs, backoffFactor), signal);
    },
    async runWithRetry<T>(work: (attempt: number, signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
      const cancellation = cancellationOf(signal);
      try {
        for (let attempt = 1; ; attempt += 1) {
          if (signal?.aborted) throw abortReason(signal);
          try {
            return await Promise.race([work(attempt, signal ?? noSignal.signal), cancellation.rejected]);
          } catch (error) {
            // A cancelled attempt is a cancellation, not a failure worth retrying.
            if (signal?.aborted) throw abortReason(signal);
            if (attempt >= options.maxAttempts || !shouldRetry(error, attempt)) throw error;
            const delay = policy.schedule(attempt, signal);
            try {
              await delay.elapsed;
            } finally {
              delay.dispose();
            }
          }
        }
      } finally {
        cancellation.dispose();
      }
    },
  };
  return policy;
}

export function createRealRetryPolicy(options: Parameters<typeof createRetryPolicy>[1]): RetryPolicy {
  return createRetryPolicy(realClock, options);
}

export function createIdleWatchdogPolicy(clock: Clock, options: { name: string; idleMs: number }): IdleWatchdogPolicy {
  requireName(options.name);
  requireDelay(options.idleMs, "idleMs");
  return {
    name: options.name,
    arm(onIdle) {
      let active = true;
      const timer = rearmingTimer(clock, options.idleMs, () => onIdle());
      timer.arm();
      return {
        kick() {
          if (active) timer.arm();
        },
        dispose() {
          if (!active) return;
          active = false;
          timer.stop();
        },
      };
    },
  };
}

export function createRealIdleWatchdogPolicy(options: { name: string; idleMs: number }): IdleWatchdogPolicy {
  return createIdleWatchdogPolicy(realClock, options);
}

/** Tick, wait, tick again — and a tick that fails ends the poller rather than being swallowed. */
export function createPollingPolicy(clock: Clock, options: { name: string; intervalMs: number }): PollingPolicy {
  requireName(options.name);
  requireDelay(options.intervalMs, "intervalMs");
  if (options.intervalMs === 0) throw new RangeError("intervalMs must be greater than 0");
  return {
    name: options.name,
    start(tick, signal) {
      let active = true;
      let scheduled: { dispose(): void } | undefined;
      let link: { dispose(): void } | undefined;
      const dispose = (): void => {
        if (!active) return;
        active = false;
        scheduled?.dispose();
        scheduled = undefined;
        link?.dispose();
      };
      const waitThenTick = (): void => {
        if (!active) return;
        scheduled = clock.schedule(options.intervalMs, () => {
          scheduled = undefined;
          runTick();
        });
      };
      const runTick = (): void => {
        if (!active) return;
        let completion: Promise<void>;
        try {
          completion = tick();
        } catch {
          // A tick that throws synchronously is a poller that cannot continue: it stops instead of spinning.
          dispose();
          return;
        }
        void completion.then(waitThenTick, () => dispose());
      };
      const polling = { dispose };
      if (signal?.aborted) {
        dispose();
        return polling;
      }
      link = followSignal(signal, dispose);
      runTick();
      return polling;
    },
  };
}

export function createRealPollingPolicy(options: { name: string; intervalMs: number }): PollingPolicy {
  return createPollingPolicy(realClock, options);
}

/** One entry per key: arming a key again replaces what was waiting on it, and expiry is by the policy's own clock. */
export function createExpiryPolicy(clock: Clock, options: { name: string; ttlMs: number }): ExpiryPolicy {
  requireName(options.name);
  requireDelay(options.ttlMs, "ttlMs");
  const pending = new Map<string, { dispose(): void }>();
  return {
    name: options.name,
    arm(key, onExpire) {
      pending.get(key)?.dispose();
      const scheduled = clock.schedule(options.ttlMs, () => {
        pending.delete(key);
        onExpire();
      });
      pending.set(key, scheduled);
      return {
        dispose() {
          // Only the arm that is still current may remove the entry: an older arm's disposal is not the newer one's.
          if (pending.get(key) !== scheduled) return;
          pending.delete(key);
          scheduled.dispose();
        },
      };
    },
  };
}

export function createRealExpiryPolicy(options: { name: string; ttlMs: number }): ExpiryPolicy {
  return createExpiryPolicy(realClock, options);
}

/**
 * Work bounded by a deadline: the work gets a signal that is aborted when the timer fires (or when the caller's own signal
 * aborts), and the caller sees a `DeadlineExceededError` — or the caller's reason — rather than a bare timeout.
 */
export function createDeadlinePolicy(clock: Clock, options: { name: string; timeoutMs: number }): DeadlinePolicy {
  if (options.name.length === 0) throw new RangeError("name must be non-empty");
  requireDelay(options.timeoutMs, "timeoutMs");
  return {
    name: options.name,
    async run<T>(work: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
      if (signal?.aborted) throw abortReason(signal);
      const controller = new AbortController();
      let expire: (error: unknown) => void = () => {};
      const expired = new Promise<never>((_resolve, fail) => {
        expire = fail;
      });
      void expired.catch(() => {});
      const cancellation = cancellationOf(signal);
      const followCaller = followSignal(signal, () => {
        // A caller who cancels aborts the work with their reason, and the deadline race loses to that same reason.
        const reason = abortErrorFor(signal!);
        cancellation.reject(reason);
        controller.abort(reason);
      });
      const deadline = clock.schedule(options.timeoutMs, () => {
        const error = new DeadlineExceededError(options.name);
        expire(error);
        controller.abort(error);
      });
      try {
        return await Promise.race([work(controller.signal), expired, cancellation.rejected]);
      } finally {
        deadline.dispose();
        followCaller.dispose();
        cancellation.dispose();
      }
    },
  };
}
