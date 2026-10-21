/**
 * Naming an operation once so both ends of the exec channel can find it.
 *
 * Every operation — read a file, run a command, execute a hook — has two sides that must not be
 * wired up by hand: the client calls it, the host runs it, and the two have to be introduced. A
 * resource is the name that does the introducing. It carries a symbol that identifies it (so two
 * resources with the same shape are still different operations), how the client builds its side from
 * a manager, and how the host registers its side with one.
 *
 * Which accessor a caller uses decides where the operation runs: the remote accessor builds the
 * client side over the manager that talks to the host, the registry accessor looks up the host side
 * that was registered locally, and the combined one prefers the local implementation and falls back
 * to the remote one — which is how the same call site serves both a local and a remote workspace.
 */

/** One operation, named: what identifies it and how each side of the channel is built from it. */
export interface Resource<Implementation, RemoteManager = unknown, ControlledManager = unknown> {
  readonly symbol: symbol
  readonly remoteImplementation: (manager: RemoteManager) => Implementation
  readonly registerControlledImplementation: (implementation: Implementation, manager: ControlledManager) => void
}

/** Names an operation. The symbol is what tells two operations of the same shape apart. */
export function createResource<Implementation, RemoteManager = unknown, ControlledManager = unknown>(
  remoteImplementation: (manager: RemoteManager) => Implementation,
  controlledImplementation: (implementation: Implementation, manager: ControlledManager) => void,
): Resource<Implementation, RemoteManager, ControlledManager> {
  return { symbol: Symbol(), remoteImplementation, registerControlledImplementation: controlledImplementation }
}

/** A resource and its local implementation, as the combined accessor takes them. */
export function resourceEntry<Implementation, RemoteManager, ControlledManager>(
  resource: Resource<Implementation, RemoteManager, ControlledManager>,
  implementation: Implementation,
): readonly [Resource<Implementation, RemoteManager, ControlledManager>, Implementation] {
  return [resource, implementation]
}

/** The part of a resource the client side needs: its name, and how to build the side. */
export interface RemoteResource<Implementation, RemoteManager> {
  readonly symbol: symbol
  readonly remoteImplementation: (manager: RemoteManager) => Implementation
}

/** Where a call runs, as the call sites see it. */
export interface ResourceAccessor<RemoteManager> {
  get<Implementation>(resource: RemoteResource<Implementation, RemoteManager>): Implementation
}

/** Builds each operation's client side over the manager that talks to the host. */
export class RemoteResourceAccessor<RemoteManager> {
  constructor(private readonly remoteExecManager: RemoteManager) {}

  get<Implementation>(resource: RemoteResource<Implementation, RemoteManager>): Implementation {
    return resource.remoteImplementation(this.remoteExecManager)
  }
}

/** What the host side of a resource has to be able to do: register itself with a manager. */
export interface RegisteredControlledResource {
  readonly symbol: symbol
  readonly registerControlledImplementation: (implementation: unknown, manager: ControlledExecManager) => void
}

/** The host side of every operation this process can serve, found by the resource's own symbol. */
export class RegistryResourceAccessor {
  /** What was registered for an operation: the resource it was registered as, and the implementation itself. */
  private readonly resources = new Map<symbol, readonly [RegisteredControlledResource, unknown]>()

  register<Implementation, RemoteManager, ControlledManager>(
    resource: Resource<Implementation, RemoteManager, ControlledManager>,
    value: Implementation,
  ): void {
    this.resources.set(resource.symbol, [resource as unknown as RegisteredControlledResource, value])
  }

  get<Implementation, RemoteManager, ControlledManager>(
    resource: Resource<Implementation, RemoteManager, ControlledManager>,
  ): Implementation | undefined {
    return this.resources.get(resource.symbol)?.[1] as Implementation | undefined
  }

  entries(): Array<readonly [RegisteredControlledResource, unknown]> {
    return [...this.resources.values()]
  }
}

/** Local implementations win over remote ones, so a workspace can override a single operation. */
export class CombinedResourceAccessor<RemoteManager> implements ResourceAccessor<RemoteManager> {
  /** Only the implementation is kept: the resource itself is the key it was filed under. */
  private readonly localResources = new Map<symbol, unknown>()

  constructor(
    private readonly baseAccessor: ResourceAccessor<RemoteManager>,
    localResourceEntries: ReadonlyArray<readonly [RemoteResource<unknown, RemoteManager>, unknown]>,
  ) {
    for (const [resource, implementation] of localResourceEntries) {
      this.localResources.set(resource.symbol, implementation)
    }
  }

  get<Implementation>(resource: RemoteResource<Implementation, RemoteManager>): Implementation {
    const local = this.localResources.get(resource.symbol)
    if (local !== undefined) return local as Implementation
    return this.baseAccessor.get(resource)
  }
}

/** What a host-side manager offers a resource that registers itself with it. */
export interface ControlledExecManager {
  register(handler: unknown): void
}
