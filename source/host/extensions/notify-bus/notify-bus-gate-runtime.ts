export type NotifyBusGateName = "slate_notify_bus" | "slate_notify_safety_poll"

export interface NotifyBusBooleanGate {
  get(): boolean
  subscribe(listener: (value: boolean) => void): () => void
}

export interface NotifyBusGateRuntimeOptions {
  readonly whenBackgroundWorkReady: Promise<void>
  readonly getGate: (name: NotifyBusGateName) => NotifyBusBooleanGate
  readonly isStopped: () => boolean
  readonly onStop: (dispose: () => void) => void
  readonly startClient: () => void
  readonly stopClient: () => void
  readonly setSafetyPollEnabled: (enabled: boolean) => void
}

export function observeNotifyBusGates(options: NotifyBusGateRuntimeOptions): void {
  let clientStarted = false
  const applyClientGate = (enabled: boolean): void => {
    if (options.isStopped() || enabled === clientStarted) return
    clientStarted = enabled
    if (enabled) options.startClient()
    else options.stopClient()
  }

  void options.whenBackgroundWorkReady.then(() => {
    if (options.isStopped()) return

    const notifyGate = options.getGate("slate_notify_bus")
    options.onStop(notifyGate.subscribe(applyClientGate))
    applyClientGate(notifyGate.get())

    const safetyGate = options.getGate("slate_notify_safety_poll")
    options.onStop(safetyGate.subscribe(options.setSafetyPollEnabled))
    options.setSafetyPollEnabled(safetyGate.get())
  })
}
