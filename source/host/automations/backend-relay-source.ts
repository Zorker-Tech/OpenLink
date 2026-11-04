/** Register listener scopes, poll their relay events, and hold acknowledgements until a sink accepts them. */
import { ERROR_BACKOFF_MS, DEFAULT_REGISTER_INTERVAL_MS, DEGRADED_REGISTER_INTERVAL_MS } from "./backend-relay-contracts.ts";
import type {
  BackendRelaySourceOptions,
  GithubRelaySink,
  RelayStatus,
  RelaySourceBundle,
  RelayWireEvent,
  SlackRelaySink,
} from "./backend-relay-contracts.ts";
import { mapRelayWireEvent, relaySubscriptionRequestOf } from "./backend-relay-events.ts";
import { githubStatusAfterRegistration, relayRegistrationIsDegraded, slackStatusAfterRegistration } from "./backend-relay-status.ts";

export { DEFAULT_REGISTER_INTERVAL_MS, DEGRADED_REGISTER_INTERVAL_MS, ERROR_BACKOFF_MS } from "./backend-relay-contracts.ts";
export { mapRelayWireEvent, relaySubscriptionRequestOf } from "./backend-relay-events.ts";
export type { RelayStatus } from "./backend-relay-contracts.ts";

export class SlateBackendRelayError extends Error {}

export function createBackendRelaySources(deps: BackendRelaySourceOptions): RelaySourceBundle {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const registerInterval = deps.registerIntervalMs ?? DEFAULT_REGISTER_INTERVAL_MS;
  const degradedInterval = Math.min(deps.degradedRegisterIntervalMs ?? DEGRADED_REGISTER_INTERVAL_MS, registerInterval);

  let slackSink: SlackRelaySink | null = null;
  let githubSink: GithubRelaySink | null = null;
  let slackListeners: Parameters<RelaySourceBundle["slack"]["setListeners"]>[0] = [];
  let githubListeners: Parameters<RelaySourceBundle["github"]["setListeners"]>[0] = [];
  let slackStatus: RelayStatus = { state: "idle" };
  let githubStatus: RelayStatus = { state: "idle" };
  let timer: { dispose(): void } | null = null;
  let ticking = false;
  let registeredKey = "";
  let registeredAt = 0;
  let degradedStreak = 0;
  let backoffUntil = 0;
  let pendingAckIds: string[] = [];

  const post = async (path: string, body: unknown): Promise<Record<string, unknown>> => {
    const backendUrl = deps.getBackendUrl();
    const token = await deps.getAccessToken({ backendUrl });
    const response = await fetchImpl(new URL(path, backendUrl), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new SlateBackendRelayError(`relay ${path} returned ${response.status}`);
    return await response.json() as Record<string, unknown>;
  };

  const registerCurrentListeners = async (): Promise<void> => {
    const request = relaySubscriptionRequestOf(slackListeners, githubListeners);
    const requestKey = JSON.stringify(request);
    const staleAfter = degradedStreak === 0
      ? registerInterval
      : Math.min(registerInterval, degradedInterval * 2 ** Math.min(degradedStreak - 1, 10));
    if (requestKey === registeredKey && Date.now() - registeredAt <= staleAfter) return;

    const result = await post("/slate/listener-subscriptions", request);
    registeredKey = requestKey;
    registeredAt = Date.now();

    const slack = slackStatusAfterRegistration(slackListeners.length > 0, result.slack as Parameters<typeof slackStatusAfterRegistration>[1]);
    const github = githubStatusAfterRegistration(githubListeners.length > 0, result.github as Parameters<typeof githubStatusAfterRegistration>[1]);
    if (slack !== undefined) slackStatus = slack;
    if (github !== undefined) githubStatus = github;
    degradedStreak = relayRegistrationIsDegraded(slackStatus, githubStatus) ? degradedStreak + 1 : 0;
  };

  const pollForListenerEvents = async (): Promise<void> => {
    const result = await post("/slate/listener-events/poll", { ackIds: pendingAckIds });
    const events = Array.isArray(result.events) ? result.events as Array<RelayWireEvent & { id: string }> : [];
    const awaitingAck = new Set(pendingAckIds);
    const nextAckIds: string[] = [];

    for (const wireEvent of events) {
      if (awaitingAck.has(wireEvent.id)) {
        nextAckIds.push(wireEvent.id);
        continue;
      }

      const event = mapRelayWireEvent(wireEvent);
      const sink = event?.source === "slack" ? slackSink : githubSink;
      if (event === null || sink?.(event) === true) nextAckIds.push(wireEvent.id);
    }
    pendingAckIds = nextAckIds;
  };

  const tick = async (): Promise<void> => {
    if (ticking || Date.now() < backoffUntil) return;
    ticking = true;
    try {
      await registerCurrentListeners();
      const notificationsUnavailable = deps.isNotifyConnected?.() === false && deps.isNotifySafetyPollEnabled?.() === false;
      if (notificationsUnavailable && pendingAckIds.length === 0) return;
      await pollForListenerEvents();
    } catch (error) {
      registeredKey = "";
      backoffUntil = Date.now() + ERROR_BACKOFF_MS;
      const detail = error instanceof Error ? error.message : "relay poll failed";
      if (slackListeners.length > 0 && slackSink !== null) slackStatus = { state: "error", detail };
      if (githubListeners.length > 0 && githubSink !== null) githubStatus = { state: "error", detail };
    } finally {
      ticking = false;
    }
  };

  const ensureLoop = (): void => {
    timer ??= deps.polling.start(tick);
  };
  const stopIfIdle = (): void => {
    if (slackSink !== null || githubSink !== null) return;
    timer?.dispose();
    timer = null;
    registeredKey = "";
    backoffUntil = 0;
  };

  const slack = {
    kind: "slack",
    async start(sink: SlackRelaySink | null): Promise<void> {
      slackSink = sink;
      slackStatus = { state: "connecting" };
      ensureLoop();
    },
    setListeners(listeners: Parameters<RelaySourceBundle["slack"]["setListeners"]>[0]): void {
      slackListeners = [...listeners];
    },
    async stop(): Promise<void> {
      slackSink = null;
      slackListeners = [];
      slackStatus = { state: "idle" };
      registeredKey = "";
      stopIfIdle();
    },
    getStatus: () => slackStatus,
  };

  const github = {
    kind: "github",
    async start(sink: GithubRelaySink | null): Promise<void> {
      githubSink = sink;
      githubStatus = { state: "connecting" };
      ensureLoop();
    },
    setListeners(listeners: Parameters<RelaySourceBundle["github"]["setListeners"]>[0]): void {
      githubListeners = [...listeners];
    },
    async stop(): Promise<void> {
      githubSink = null;
      githubListeners = [];
      githubStatus = { state: "idle" };
      registeredKey = "";
      stopIfIdle();
    },
    getStatus: () => githubStatus,
  };

  return { slack, github, requestDrain: () => { void tick(); } };
}
