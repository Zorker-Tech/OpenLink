import { MAX_SPOOL_PURGE_SHIFTS } from "./sentry-contracts.ts";
import type { SlateSentrySpoolStore } from "./sentry-contracts.ts";
import { isEnvelopeRecord } from "./sentry-envelope-values.ts";

function isObjectReference(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

/** Add a bounded purge operation and prevent an old shifted item returning after that purge. */
export function purgeableSpoolStore<T extends SlateSentrySpoolStore>(store: T): T & { purge(): Promise<number> } {
  let purgeEpoch = 0;
  const shiftedAtEpoch = new WeakMap<object, number>();

  const cameFromBeforePurge = (envelope: unknown): boolean => {
    if (!isObjectReference(envelope)) return false;
    const shiftedEpoch = shiftedAtEpoch.get(envelope);
    return shiftedEpoch !== undefined && shiftedEpoch < purgeEpoch;
  };

  const shiftAndRemember = async (): Promise<unknown | undefined> => {
    const envelope = await store.shift();
    if (isObjectReference(envelope)) shiftedAtEpoch.set(envelope, purgeEpoch);
    return envelope;
  };

  const purgeQueuedItems = async (): Promise<number> => {
    let removed = 0;
    while (removed < MAX_SPOOL_PURGE_SHIFTS && await store.shift() !== undefined) removed += 1;
    purgeEpoch += 1;
    return removed;
  };

  return {
    ...store,
    push: (envelope) => store.push(envelope),
    unshift: (envelope) => cameFromBeforePurge(envelope) ? Promise.resolve() : store.unshift(envelope),
    shift: shiftAndRemember,
    purge: purgeQueuedItems,
  } as T & { purge(): Promise<number> };
}

/** Wrap the offline transport store factory once the SDK asks to construct its queue. */
export function captureOfflineSpoolStore(
  transportOptions: unknown,
  capture: (store: ReturnType<typeof purgeableSpoolStore>) => void,
): void {
  if (!isEnvelopeRecord(transportOptions) || typeof transportOptions.createStore !== "function") return;

  const createStore = transportOptions.createStore as (...args: unknown[]) => SlateSentrySpoolStore;
  transportOptions.createStore = (...args: unknown[]) => {
    const store = purgeableSpoolStore(createStore.apply(transportOptions, args));
    capture(store);
    return store;
  };
}
