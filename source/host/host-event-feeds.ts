/** A small extension surface is enough to connect a subscription to a gateway event channel. */
export interface HostFeedRegistry {
  api(id: string): Record<string, unknown>;
}

export interface HostFeedBinding {
  readonly extension: string;
  readonly subscribe: string;
  readonly channel: string;
}

/** Bind optional extension feeds from a declaration table; absent feeds are a supported host shape. */
export function bindHostFeeds(
  registry: HostFeedRegistry,
  bindings: readonly HostFeedBinding[],
  publish: (event: unknown) => void,
): void {
  for (const binding of bindings) {
    const api = registry.api(binding.extension);
    const candidate = api[binding.subscribe];
    if (typeof candidate !== "function") continue;
    const subscribe = candidate as (listener: (payload: unknown) => void) => unknown;
    subscribe.call(api, (payload) => {
      publish({
        channel: binding.channel,
          payload,
      });
    });
  }
}
