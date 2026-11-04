export interface Resource<Implementation, RemoteManager = unknown, ControlledManager = unknown> {
  readonly symbol: symbol
  readonly remoteImplementation: (manager: RemoteManager) => Implementation
  readonly registerControlledImplementation: (
    implementation: Implementation,
    manager: ControlledManager,
  ) => void
}

export function createResource<Implementation, RemoteManager = unknown, ControlledManager = unknown>(
  remoteImplementation: (manager: RemoteManager) => Implementation,
  controlledImplementation: (implementation: Implementation, manager: ControlledManager) => void,
): Resource<Implementation, RemoteManager, ControlledManager> {
  return Object.freeze({
    symbol: Symbol("slate.exec.resource"),
    remoteImplementation,
    registerControlledImplementation: controlledImplementation,
  })
}

export function resourceEntry<Implementation, RemoteManager, ControlledManager>(
  resource: Resource<Implementation, RemoteManager, ControlledManager>,
  implementation: Implementation,
): readonly [Resource<Implementation, RemoteManager, ControlledManager>, Implementation] {
  return [resource, implementation]
}

export interface RemoteResource<Implementation, RemoteManager> {
  readonly symbol: symbol
  readonly remoteImplementation: (manager: RemoteManager) => Implementation
}

export interface ResourceAccessor<RemoteManager> {
  get<Implementation>(resource: RemoteResource<Implementation, RemoteManager>): Implementation
}

export class RemoteResourceAccessor<RemoteManager> {
  constructor(private readonly remoteExecManager: RemoteManager) {}

  get<Implementation>(resource: RemoteResource<Implementation, RemoteManager>): Implementation {
    return resource.remoteImplementation(this.remoteExecManager)
  }
}

export interface RegisteredControlledResource {
  readonly symbol: symbol
  readonly registerControlledImplementation: (
    implementation: unknown,
    manager: ControlledExecManager,
  ) => void
}

type RegistryEntry = readonly [RegisteredControlledResource, unknown]

export class RegistryResourceAccessor {
  private readonly registrations = new Map<symbol, RegistryEntry>()

  register<Implementation, RemoteManager, ControlledManager>(
    resource: Resource<Implementation, RemoteManager, ControlledManager>,
    value: Implementation,
  ): void {
    this.registrations.set(resource.symbol, [
      resource as unknown as RegisteredControlledResource,
      value,
    ])
  }

  get<Implementation, RemoteManager, ControlledManager>(
    resource: Resource<Implementation, RemoteManager, ControlledManager>,
  ): Implementation | undefined {
    const registration = this.registrations.get(resource.symbol)
    return registration === undefined ? undefined : registration[1] as Implementation
  }

  entries(): RegistryEntry[] {
    return Array.from(this.registrations.values())
  }
}

export class CombinedResourceAccessor<RemoteManager> implements ResourceAccessor<RemoteManager> {
  private readonly localImplementations = new Map<symbol, unknown>()

  constructor(
    private readonly baseAccessor: ResourceAccessor<RemoteManager>,
    localResourceEntries: ReadonlyArray<readonly [RemoteResource<unknown, RemoteManager>, unknown]>,
  ) {
    for (const [resource, implementation] of localResourceEntries) {
      this.localImplementations.set(resource.symbol, implementation)
    }
  }

  get<Implementation>(resource: RemoteResource<Implementation, RemoteManager>): Implementation {
    const implementation = this.localImplementations.get(resource.symbol)
    return implementation === undefined
      ? this.baseAccessor.get(resource)
      : implementation as Implementation
  }
}

export interface ControlledExecManager {
  register(handler: unknown): void
}
