/** The notification bus as a host extension: the client is wired here and closed when the host stops. */
import { createRealIdleWatchdogPolicy, createRealRetryPolicy } from "../scheduling.ts";
import { defineHostExtension } from "../host-extensions.ts";
import { errorLogTag } from "../../../shared/errors/summary.ts";
import { getConfiguredBackendUrl } from "../../../shared/node/slate-token.ts";
import { HostExtensions } from "../extension-ids.generated.ts";
import { SlateNotifyBusClient, SLATE_NOTIFY_TOPICS, type SlateNotifyTopic } from "./notify-bus-client.ts";

export const RECONNECT_INITIAL_DELAY_MS = 1_000;
export const RECONNECT_MAX_DELAY_MS = 60_000;
export const NOTIFY_STREAM_STALL_MS = 35_000;
export const SAFETY_POLL_DEFAULT_BEFORE_GATE_RESOLVES = true;

interface AuthApi { getAccessToken(options: { readonly backendUrl: string }): Promise<string>; }
interface GateProperty { get(): boolean; subscribe(listener: (value: boolean) => void): () => void; }
interface ExperimentsApi { getFeatureGateProperty(name: string): GateProperty; }

export const notifyBusExtension = defineHostExtension<{
  onNotify(topic: SlateNotifyTopic, handler: () => void): () => void;
  isConnected(): boolean;
  isSafetyPollEnabled(): boolean;
}, { readonly log: (message: string) => void; readonly whenBackgroundWorkReady: Promise<void> }>({
  id: HostExtensions.NotifyBus,
  dependencies: [HostExtensions.Auth, HostExtensions.Experiments],
  start: (context) => {
    const auth = context.deps[HostExtensions.Auth] as AuthApi;
    const experiments = context.deps[HostExtensions.Experiments] as ExperimentsApi;
    const handlersByTopic: Record<SlateNotifyTopic, Set<() => void>> = {
      "automation-fires": new Set(), "listener-events": new Set(), "xuser-events": new Set()
    };
    let isStopped = false;
    const fire = (topic: SlateNotifyTopic) => {
      for (const handler of handlersByTopic[topic]) {
        try { handler(); }
        catch (error) { context.host.log(`[slate:notify-bus] ${topic} drain handler failed: ${errorLogTag(error)}`); }
      }
    };
    const client = new SlateNotifyBusClient({
      getBackendUrl: () => getConfiguredBackendUrl(),
      getAccessToken: (options) => auth.getAccessToken(options),
      onConnected: () => { for (const topic of SLATE_NOTIFY_TOPICS) fire(topic); },
      onNotify: fire,
      onStreamError: (error) => context.host.log(`[slate:notify-bus] stream failed: ${errorLogTag(error)}`),
      reconnectBackoff: createRealRetryPolicy({ name: "notify-bus.reconnect", maxAttempts: Number.MAX_SAFE_INTEGER, initialDelayMs: RECONNECT_INITIAL_DELAY_MS, maxDelayMs: RECONNECT_MAX_DELAY_MS }),
      stallWatchdog: createRealIdleWatchdogPolicy({ name: "notify-bus.stall-watchdog", idleMs: NOTIFY_STREAM_STALL_MS })
    });
    let isClientStarted = false;
    const applyGate = (isOn: boolean) => {
      if (isStopped || isOn === isClientStarted) return;
      isClientStarted = isOn;
      if (isOn) client.start(); else client.stop();
    };
    context.onStop(() => { isStopped = true; client.stop(); for (const handlers of Object.values(handlersByTopic)) handlers.clear(); });
    let isSafetyPollEnabled = SAFETY_POLL_DEFAULT_BEFORE_GATE_RESOLVES;
    void context.host.whenBackgroundWorkReady.then(() => {
      if (isStopped) return;
      const gate = experiments.getFeatureGateProperty("slate_notify_bus");
      context.onStop(gate.subscribe(applyGate));
      applyGate(gate.get());
      const safetyGate = experiments.getFeatureGateProperty("slate_notify_safety_poll");
      context.onStop(safetyGate.subscribe((isOn) => { isSafetyPollEnabled = isOn; }));
      isSafetyPollEnabled = safetyGate.get();
    });
    return {
      onNotify(topic, handler) { handlersByTopic[topic].add(handler); return () => handlersByTopic[topic].delete(handler); },
      isConnected: () => client.isConnected(),
      isSafetyPollEnabled: () => isSafetyPollEnabled
    };
  }
});
