/**
 * Readers watching a value, and the plumbing both the host and the adapter share.
 *
 * One place decides what watching means here: a reader can ask for the current value or subscribe to changes, one
 * subscriber that throws never costs another its notification, and letting a channel go stops the notifications
 * without erasing what was last published.
 */

export interface Receiver<T> {
  subscribe(listener: (value: T) => void): { dispose(): void };
}

export interface WatchReceiver<T> extends Receiver<T> {
  get(): T;
}

export interface ListenerSet<T> extends Receiver<T> {
  notify(value: T): void;
  clear(): void;
}

/** Listeners notified one by one, each failure reported so the next listener still hears. */
export function createListenerSet<T>(onListenerFailure: (error: unknown) => void): ListenerSet<T> {
  const listeners = new Set<(value: T) => void>();
  return {
    subscribe(listener) {
      listeners.add(listener);
      return { dispose: () => void listeners.delete(listener) };
    },
    notify(value) {
      for (const listener of listeners) {
        try {
          listener(value);
        } catch (error) {
          onListenerFailure(error);
        }
      }
    },
    clear: () => listeners.clear(),
  };
}

export interface WatchChannel<T> {
  readonly receiver: WatchReceiver<T>;
  /** The value published last — the initial one until something publishes. */
  readonly current: T;
  publish(value: T): void;
  /** Stops the notifications; the current value stays readable. */
  stop(): void;
}

export function createWatchChannel<T>(initial: T, onSubscriberFailure: (error: unknown) => void): WatchChannel<T> {
  const listeners = createListenerSet<T>(onSubscriberFailure);
  let value = initial;
  return {
    receiver: { get: () => value, subscribe: listeners.subscribe },
    get current() {
      return value;
    },
    publish(next) {
      value = next;
      listeners.notify(next);
    },
    stop: () => listeners.clear(),
  };
}
