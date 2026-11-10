/** Connects the host notification stream to extension subscribers. */
import { defineHostExtension } from "../host-extensions.ts"
import { errorLogTag } from "../../../shared/errors/summary.ts"
import { getConfiguredBackendUrl } from "../../../shared/node/slate-token.ts"
import { HostExtensions } from "../extension-ids.generated.ts"
import { SlateNotifyBusClient, SLATE_NOTIFY_TOPICS, type SlateNotifyTopic } from "./notify-bus-client.ts"
import { createRealIdleWatchdogPolicy, createRealRetryPolicy } from "../scheduling.ts"
import { createNotifyBusHandlers } from "./notify-bus-handlers.ts"
import { observeNotifyBusGates, type NotifyBusBooleanGate } from "./notify-bus-gate-runtime.ts"

export const RECONNECT_INITIAL_DELAY_MS = 1_000
export const RECONNECT_MAX_DELAY_MS = 60_000
export const NOTIFY_STREAM_STALL_MS = 35_000
export const SAFETY_POLL_DEFAULT_BEFORE_GATE_RESOLVES = true

interface AuthApi {
  getAccessToken(options: { readonly backendUrl: string }): Promise<string>
}

interface ExperimentsApi {
  getFeatureGateProperty(name: string): NotifyBusBooleanGate
}

export const notifyBusExtension = defineHostExtension<{
  onNotify(topic: SlateNotifyTopic, handler: () => void): () => void
  isConnected(): boolean
  isSafetyPollEnabled(): boolean
}, { readonly log: (message: string) => void; readonly whenBackgroundWorkReady: Promise<void> }>({
  id: HostExtensions.NotifyBus,
  dependencies: [HostExtensions.Auth, HostExtensions.Experiments],
  start(context) {
    const auth = context.deps[HostExtensions.Auth] as AuthApi
    const experiments = context.deps[HostExtensions.Experiments] as ExperimentsApi
    const handlers = createNotifyBusHandlers(context.host.log)
    let stopped = false
    let safetyPollEnabled = SAFETY_POLL_DEFAULT_BEFORE_GATE_RESOLVES

    const client = new SlateNotifyBusClient({
      getBackendUrl: () => getConfiguredBackendUrl(),
      getAccessToken: options => auth.getAccessToken(options),
      onConnected: () => {
        for (const topic of SLATE_NOTIFY_TOPICS) handlers.dispatch(topic)
      },
      onNotify: topic => handlers.dispatch(topic),
      onStreamError: error => context.host.log("[slate:notify-bus] stream failed: " + errorLogTag(error)),
      reconnectBackoff: createRealRetryPolicy({
        name: "notify-bus.reconnect",
        maxAttempts: Number.MAX_SAFE_INTEGER,
        initialDelayMs: RECONNECT_INITIAL_DELAY_MS,
        maxDelayMs: RECONNECT_MAX_DELAY_MS,
      }),
      stallWatchdog: createRealIdleWatchdogPolicy({
        name: "notify-bus.stall-watchdog",
        idleMs: NOTIFY_STREAM_STALL_MS,
      }),
    })

    context.onStop(() => {
      stopped = true
      client.stop()
      handlers.clear()
    })
    observeNotifyBusGates({
      whenBackgroundWorkReady: context.host.whenBackgroundWorkReady,
      getGate: name => experiments.getFeatureGateProperty(name),
      isStopped: () => stopped,
      onStop: dispose => context.onStop(dispose),
      startClient: () => client.start(),
      stopClient: () => client.stop(),
      setSafetyPollEnabled: enabled => { safetyPollEnabled = enabled },
    })

    return {
      onNotify: (topic, handler) => handlers.subscribe(topic, handler),
      isConnected: () => client.isConnected(),
      isSafetyPollEnabled: () => safetyPollEnabled,
    }
  },
})
