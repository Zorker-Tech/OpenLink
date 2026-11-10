import type { RetryPolicy } from "../scheduling.ts"
import type { CsnapsCodebaseTelemetryAdapter, Logger } from "./codebase-telemetry-adapter.ts"
import type { TelemetryAuth } from "./privacy-mode.ts"
import type { WatchReceiver } from "./watch-channel.ts"

export interface CodebaseTelemetrySessionOptions {
  readonly accounts: WatchReceiver<TelemetryAuth | undefined>
  readonly desiredCodebases: () => readonly unknown[]
  readonly createAdapter: (input: { credentials: TelemetryAuth; signal: AbortSignal }) => Promise<CsnapsCodebaseTelemetryAdapter>
  readonly restartDelay: RetryPolicy
  readonly logger: Logger
}

/** Owns one helper at a time and discards any start that finishes for an account that is no longer current. */
export function createCodebaseTelemetrySession(options: CodebaseTelemetrySessionOptions) {
  let current: CsnapsCodebaseTelemetryAdapter | undefined
  let startAbort: AbortController | undefined
  let pendingRestart: { readonly elapsed: Promise<void>; dispose(): void } | undefined
  let restartTask: Promise<void> | undefined
  let stopped = false
  let revision = 0

  const alignAdapter = async (credentials: TelemetryAuth | undefined): Promise<void> => {
    const ownRevision = ++revision
    startAbort?.abort()
    startAbort = undefined

    const retiring = current
    current = undefined
    await retiring?.close()
    if (credentials == null || stopped || ownRevision !== revision) return

    const abort = new AbortController()
    startAbort = abort
    try {
      const candidate = await options.createAdapter({ credentials, signal: abort.signal })
      if (abort.signal.aborted || stopped || ownRevision !== revision) {
        await candidate.close()
        return
      }

      current = candidate
      void candidate.terminalFailure.then(() => recover(candidate))
      await candidate.setDesiredCodebases(options.desiredCodebases())
    } catch (error) {
      if (!abort.signal.aborted && !stopped && ownRevision === revision) {
        options.logger.error("Failed to start Codebase Telemetry adapter", error)
      }
    }
  }

  const recover = (failed: CsnapsCodebaseTelemetryAdapter): void => {
    if (stopped || current !== failed || restartTask !== undefined) return

    restartTask = (async () => {
      await alignAdapter(undefined)
      if (stopped) return

      const wait = options.restartDelay.schedule(1)
      pendingRestart = wait
      try {
        await wait.elapsed
      } catch (error) {
        if (!stopped) throw error
        return
      } finally {
        if (pendingRestart === wait) pendingRestart = undefined
        wait.dispose()
      }

      if (!stopped) await alignAdapter(options.accounts.get())
    })().finally(() => {
      restartTask = undefined
    })
    void restartTask.catch((error) => options.logger.error("Failed to restart Codebase Telemetry after adapter failure", error))
  }

  const accountSubscription = options.accounts.subscribe((credentials) => void alignAdapter(credentials))
  void alignAdapter(options.accounts.get())

  return {
    get current(): CsnapsCodebaseTelemetryAdapter | undefined {
      return current
    },
    async flushPendingUploads(): Promise<void> {
      if (current !== undefined) await current.flushPendingUploads()
    },
    stop(): void {
      if (stopped) return
      stopped = true
      revision += 1
      startAbort?.abort()
      pendingRestart?.dispose()
      accountSubscription.dispose()
    },
    async close(): Promise<void> {
      const retiring = current
      current = undefined
      await retiring?.close()
    },
  }
}
