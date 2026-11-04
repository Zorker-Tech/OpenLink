export interface CoordinatorPortOutcome {
  readonly outcome: string
  readonly detail?: string | undefined
}

export interface CoordinatorShutdownResources {
  readonly closeGateway: () => void
  readonly clearToolRelay: () => void
  readonly disposeLocalExec: () => void
  readonly disposeOAuthForwarder: () => void
  readonly stopControlPort: () => void
  readonly closeRendererPort: () => void
  readonly closeMainPort: () => void
  readonly closeCarrierControl: () => void
  readonly closeCarrierData: () => void
  readonly closeCarrierMainData: () => void
  readonly exitProcess: (code: number) => void
}

/** End the process once after all locally owned resources have been told to stop. */
export function createCoordinatorStopHandler(resources: CoordinatorShutdownResources): (code: number) => void {
  let stopped = false
  return (code) => {
    if (stopped) return
    stopped = true
    resources.closeGateway()
    resources.clearToolRelay()
    resources.disposeLocalExec()
    resources.disposeOAuthForwarder()
    resources.stopControlPort()
    resources.closeRendererPort()
    resources.closeMainPort()
    resources.closeCarrierControl()
    resources.closeCarrierData()
    resources.closeCarrierMainData()
    resources.exitProcess(code)
  }
}

export function observeCoordinatorPort(
  settled: Promise<CoordinatorPortOutcome>,
  options: {
    readonly breachLabel: string
    readonly prefix: string
    readonly report: (message: string) => void
    readonly stop: (code: number) => void
  },
): void {
  void settled.then((state) => {
    const failed = state.outcome === "protocol-breach"
    if (failed) options.report(`${options.prefix}${options.breachLabel}: ${state.detail}\n`)
    options.stop(failed ? 1 : 0)
  })
}

export type CoordinatorCrashKind = "uncaughtException" | "unhandledRejection"

export function createCoordinatorCrashHandler(options: {
  readonly prefix: string
  readonly report: (message: string) => void
  readonly submitReport: (report: {
    readonly kind: CoordinatorCrashKind
    readonly errorName: string
    readonly errorMessage: string
    readonly errorStack: string | null
  }) => Promise<unknown>
  readonly stop: (code: number) => void
}): (kind: CoordinatorCrashKind, value: unknown) => void {
  return (kind, value) => {
    const error = value instanceof Error ? value : new Error(String(value))
    options.report(`${options.prefix}${kind}: ${error.stack ?? String(error)}\n`)
    void options.submitReport({
      kind,
      errorName: error.name,
      errorMessage: error.message,
      errorStack: error.stack ?? null,
    }).catch(reportError => options.report(`${options.prefix}crash report undelivered: ${String(reportError)}\n`))
    options.stop(1)
  }
}
