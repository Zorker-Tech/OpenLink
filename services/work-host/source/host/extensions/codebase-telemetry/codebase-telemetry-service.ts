import { DeadlineExceededError, type DeadlinePolicy, type PollingPolicy, type RetryPolicy } from "../scheduling.ts"
import { CodebaseSnapshotTrigger } from "./codebase-snapshot-trigger.ts"
import { createSlateCodebaseTelemetryHost } from "./codebase-telemetry-host.ts"
import { createCodebaseTelemetrySession } from "./codebase-telemetry-session.ts"
import { createCodebaseTelemetryPrivacyMode, type PrivacyMode, type TelemetryAuth } from "./privacy-mode.ts"
import type { CsnapsCodebaseTelemetryAdapter, Logger } from "./codebase-telemetry-adapter.ts"

export function createSlateCodebaseTelemetryLogger(writeLine: (line: string) => void): Logger {
  const format = (level: string, message: string, error?: unknown): void => {
    const detail = error === undefined ? "" : `: ${error instanceof Error ? error.message : String(error)}`
    writeLine(`[codebase-telemetry] ${level}: ${message}${detail}`)
  }
  return {
    error: (message, error) => format("error", message, error),
    warn: (message, error) => format("warn", message, error),
    info: (message, error) => format("info", message, error),
    debug: (message, error) => format("debug", message, error),
  }
}

export interface CodebaseTelemetryServiceOptions {
  readonly auth: Parameters<typeof createSlateCodebaseTelemetryHost>[0]["auth"]
  readonly experiments: Parameters<typeof createSlateCodebaseTelemetryHost>[0]["experiments"]
  readonly events: { on(topic: string, listener: (event: { requestId: string }) => void): () => void }
  readonly createAdapter: (input: { credentials: TelemetryAuth; signal: AbortSignal }) => Promise<CsnapsCodebaseTelemetryAdapter>
  readonly loadPrivacyMode: (args: { auth: TelemetryAuth; signal: AbortSignal }) => Promise<PrivacyMode>
  readonly policies: {
    privacyLookupDeadline: DeadlinePolicy
    privacyLookupRetry: RetryPolicy
    privacyRefreshPolling: PollingPolicy
    sessionRestartDelay: RetryPolicy
    shutdownDeadline: DeadlinePolicy
  }
  readonly logger: Logger
}

export function createCodebaseTelemetryService(options: CodebaseTelemetryServiceOptions) {
  const privacyMode = createCodebaseTelemetryPrivacyMode({
    load: options.loadPrivacyMode,
    lookupDeadline: options.policies.privacyLookupDeadline,
    lookupRetry: options.policies.privacyLookupRetry,
    refreshPolling: options.policies.privacyRefreshPolling,
    logger: options.logger,
  })
  const host = createSlateCodebaseTelemetryHost({
    auth: options.auth,
    experiments: options.experiments,
    privacyMode,
    createAdapter: (input) => options.createAdapter(input as { credentials: TelemetryAuth; signal: AbortSignal }),
    logger: options.logger,
  })
  const session = createCodebaseTelemetrySession({
    accounts: host.auth,
    desiredCodebases: () => host.desiredCodebases.get(),
    createAdapter: (input) => host.createAdapter(input) as Promise<CsnapsCodebaseTelemetryAdapter>,
    restartDelay: options.policies.sessionRestartDelay,
    logger: options.logger,
  })
  const snapshots = new CodebaseSnapshotTrigger({ getSession: () => session.current, logger: options.logger })
  const removeStartListener = options.events.on("transcript.run-started", ({ requestId }) => {
    snapshots.handle({ type: "AGENT_REQUEST_START", requestId })
  })
  const removeEndListener = options.events.on("transcript.run-ended", ({ requestId }) => {
    snapshots.handle({ type: "AGENT_REQUEST_END", requestId })
  })

  let shutdown: Promise<void> | undefined
  return {
    api: { flushPendingUploads: () => session.flushPendingUploads() },
    dispose(): Promise<void> {
      session.stop()
      return (shutdown ??= (async () => {
        removeStartListener()
        removeEndListener()
        try {
          await options.policies.shutdownDeadline.run(() => session.close())
        } catch (error) {
          if (!(error instanceof DeadlineExceededError)) throw error
          options.logger.warn("Controller shutdown exceeded its deadline", error)
        } finally {
          host.dispose()
          privacyMode.dispose()
        }
      })())
    },
  }
}
