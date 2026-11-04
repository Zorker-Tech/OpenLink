export interface ContentSearchFeatureGate {
  get(): boolean
  subscribe(listener: (value: boolean) => void): () => void
}

export interface ContentSearchLifecycleIndex<Mutation> {
  start(): void
  dispose(): void | Promise<void>
  applyMutation(mutation: Mutation): void
}

export function bindContentSearchGateLifecycle<Mutation>(options: {
  readonly gate: ContentSearchFeatureGate
  readonly index: ContentSearchLifecycleIndex<Mutation>
  readonly subscribeMutations: (listener: (mutation: Mutation) => void) => () => void
  readonly onStop: (teardown: () => void | Promise<void>) => void
}): void {
  let unsubscribeMutations: (() => void) | undefined

  const updateForGate = (enabled: boolean): void => {
    if (!enabled) {
      unsubscribeMutations?.()
      unsubscribeMutations = undefined
      return
    }

    unsubscribeMutations ??= options.subscribeMutations(mutation => options.index.applyMutation(mutation))
    options.index.start()
  }

  options.onStop(() => options.index.dispose())
  options.onStop(() => unsubscribeMutations?.())
  options.onStop(options.gate.subscribe(updateForGate))
  updateForGate(options.gate.get())
}
