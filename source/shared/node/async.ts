import { realClock, type Clock } from "../../host/extensions/scheduling.ts";

function effectiveDelay(milliseconds: number): number {
  return Number.isFinite(milliseconds) && milliseconds > 0 ? milliseconds : 0;
}

function waitForScheduledDelay(
  clock: Clock,
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise(resolve => {
    if (signal?.aborted === true) {
      resolve();
      return;
    }

    let scheduled: ReturnType<Clock["schedule"]> | undefined;
    const onAbort = (): void => {
      scheduled?.dispose();
      resolve();
    };
    const onElapsed = (): void => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };

    scheduled = clock.schedule(milliseconds, onElapsed);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return delayWith(realClock, milliseconds, signal);
}

export function delayWith(clock: Clock, milliseconds: number, signal?: AbortSignal): Promise<void> {
  return waitForScheduledDelay(clock, effectiveDelay(milliseconds), signal);
}
