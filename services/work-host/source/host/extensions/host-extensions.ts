/**
 * How a host extension is written.
 *
 * An extension is given its dependencies and the host it belongs to, registers itself against the extension's own id,
 * and is handed a place to put what has to be torn down when the host stops.
 */

/** What an extension is handed when it starts: its peers' apis, the host, and a place to put a teardown. */
export interface HostExtensionContext<Host = unknown> {
  readonly deps: Record<string, unknown>;
  readonly host: Host;
  readonly onStop: (teardown: () => void | Promise<void>) => void;
}

/** One extension: who it is, what it needs, and how it starts. */
export interface HostExtensionDeclaration<Api = unknown, Host = unknown> {
  readonly kind: "host-extension";
  readonly id: string;
  readonly dependencies: readonly string[];
  readonly start: (context: HostExtensionContext<Host>) => Api | Promise<Api>;
}

/** Declares an extension. The declaration is frozen, and so is its list of peers, so a boot order cannot be rewritten later. */
export function defineHostExtension<Api, Host = unknown>(options: Omit<HostExtensionDeclaration<Api, Host>, "kind">): HostExtensionDeclaration<Api, Host> {
  const declared: HostExtensionDeclaration<Api, Host> = {
    kind: "host-extension",
    id: options.id,
    dependencies: Object.freeze([...options.dependencies]),
    start: options.start,
  };
  return Object.freeze(declared);
}

/**
 * A topic bus the host's capabilities subscribe to.
 *
 * A handler that fails does not stop its peers from being told, and what failed is reported to the host rather than
 * swallowed; a caller that wants the failure to reach it asks for that when it emits.
 */
export function createHostEvents(options: { readonly onHandlerFailure: (topic: string, error: unknown) => void }) {
  const subscribers = new Map<string, Set<(payload: unknown) => unknown>>();

  return {
    async emit(topic: string, payload: unknown, emitOptions?: { readonly failureMode?: "reject" }): Promise<void> {
      const handlers = subscribers.get(topic);
      if (handlers === undefined || handlers.size === 0) return;
      // Wrapped so that a handler which throws without awaiting is a failed delivery, not a throw out of `emit`.
      const outcomes = await Promise.allSettled([...handlers].map(async (handler) => handler(payload)));
      const rejected = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
      for (const outcome of rejected) options.onHandlerFailure(topic, outcome.reason);
      if (rejected.length > 0 && emitOptions?.failureMode === "reject") throw rejected[0]?.reason;
    },

    on(topic: string, handler: (payload: unknown) => unknown): () => void {
      const handlers = subscribers.get(topic) ?? new Set();
      handlers.add(handler);
      subscribers.set(topic, handlers);
      return () => {
        handlers.delete(handler);
      };
    },
  };
}

export class HostExtensionGraphError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HostExtensionGraphError";
  }
}

export class HostExtensionStartError extends Error {
  constructor(readonly extensionId: string, cause: unknown) {
    super(`host extension "${extensionId}" failed to start`, { cause });
    this.name = "HostExtensionStartError";
  }
}

/**
 * The peers each extension names, checked before anything starts.
 *
 * Two extensions cannot share an id, an extension cannot wait on itself, and a peer that this build does not contain
 * is a mistake in the declaration rather than something to wait for.
 */
class PeerGraph<Host> {
  private readonly peers = new Map<string, readonly string[]>();

  constructor(extensions: readonly HostExtensionDeclaration<unknown, Host>[]) {
    for (const extension of extensions) {
      if (this.peers.has(extension.id)) throw new HostExtensionGraphError(`two host extensions declare the id "${extension.id}"`);
      this.peers.set(extension.id, [...extension.dependencies]);
    }
    for (const extension of extensions) {
      for (const dependency of extension.dependencies) {
        if (dependency === extension.id) throw new HostExtensionGraphError(`host extension "${extension.id}" declares itself as a peer`);
        if (!this.peers.has(dependency)) throw new HostExtensionGraphError(`host extension "${extension.id}" requires the peer "${dependency}", which is not in this build`);
      }
    }
  }

  get ids(): string[] {
    return [...this.peers.keys()].sort();
  }

  peersOf(id: string): readonly string[] {
    return this.peers.get(id) ?? [];
  }

  /**
   * The order the extensions can start in: always the first one — by id — whose peers are all already started.
   *
   * When no extension is ready and some are left, the peers form a cycle, and the path around it is named.
   */
  order(): string[] {
    const waiting = new Map<string, Set<string>>(this.ids.map((id) => [id, new Set(this.peersOf(id))]));
    const started: string[] = [];
    const done = new Set<string>();
    while (waiting.size > 0) {
      const ready = [...waiting.keys()].sort().find((id) => [...(waiting.get(id) ?? [])].every((peer) => done.has(peer)));
      if (ready === undefined) throw new HostExtensionGraphError(`host extension peer cycle: ${this.describeCycle(new Set(started))}`);
      waiting.delete(ready);
      done.add(ready);
      started.push(ready);
    }
    return started;
  }

  /** Walks the peers that have not started yet and names the first path that comes back to where it began. */
  describeCycle(done: ReadonlySet<string>): string {
    const path: string[] = [];
    const walk = (id: string): string[] | null => {
      const cameBackTo = path.indexOf(id);
      if (cameBackTo !== -1) return [...path.slice(cameBackTo), id];
      path.push(id);
      for (const peer of [...this.peersOf(id)].sort()) {
        if (done.has(peer)) continue;
        const cycle = walk(peer);
        if (cycle !== null) return cycle;
      }
      path.pop();
      return null;
    };
    const unsettled = this.ids.filter((id) => !done.has(id));
    for (const id of unsettled) {
      const cycle = walk(id);
      if (cycle !== null) return cycle.join(" → ");
    }
    return unsettled.join(" → ");
  }
}

/** The start order of these extensions, and the reason they cannot be ordered when they cannot. */
export function resolveHostExtensionBootOrder<Host = unknown>(extensions: readonly HostExtensionDeclaration<unknown, Host>[]): string[] {
  return new PeerGraph<Host>(extensions).order();
}

/**
 * Starts every extension in boot order, handing each one the apis of the peers it named.
 *
 * If one fails to start, the ones already started are stopped again — newest first — before the failure is reported,
 * so a half-started host is never left running.
 */
export async function startHostExtensions<Host>(options: {
  readonly extensions: readonly HostExtensionDeclaration<unknown, Host>[];
  readonly host: Host;
  readonly onStopFailure: (extensionId: string, error: unknown) => void;
}) {
  const order = resolveHostExtensionBootOrder(options.extensions);
  const byId = new Map(options.extensions.map((extension) => [extension.id, extension]));
  const apis: Record<string, unknown> = {};
  const teardowns: Array<{ extensionId: string; run: () => void | Promise<void> }> = [];

  /** Runs every teardown this host has collected, newest first, and reports each one that fails without stopping. */
  const stopStarted = async () => {
    for (const teardown of teardowns.splice(0).reverse()) {
      try {
        await teardown.run();
      } catch (error) {
        options.onStopFailure(teardown.extensionId, error);
      }
    }
  };

  for (const id of order) {
    const extension = byId.get(id);
    if (extension === undefined) throw new HostExtensionGraphError(`the resolved boot order names an unknown host extension "${id}"`);
    const deps: Record<string, unknown> = {};
    for (const dependency of extension.dependencies) deps[dependency] = apis[dependency];
    try {
      apis[id] = await extension.start({ deps, host: options.host, onStop: (run) => teardowns.push({ extensionId: id, run }) });
    } catch (error) {
      await stopStarted();
      throw new HostExtensionStartError(id, error);
    }
  }

  return { order, apis, stop: stopStarted };
}
