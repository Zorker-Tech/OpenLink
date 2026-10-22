/**
 * The coordinator's composition root: everything the coordinator is, built in one place.
 *
 * It adopts the carrier it was handed (and refuses to run without one), builds the ports the rest of the process talks
 * through, and wires the gateway, the host supervisor, the local-exec daemon, the WebAuthn ceremonies and the platform
 * inference routing together. Three things about the way it ends matter: a carrier that was not adopted ends the
 * process with the reason on stderr; a port that broke its protocol ends it as a failure rather than quietly; and a
 * crash is reported through the control port before the process goes, so the reason survives the process that had it.
 */

import { hostname } from "node:os";
import { pathToFileURL } from "node:url";

import { COORDINATOR_TRANSPORT_STATE_FAMILY } from "../shared/rpc/coordinator-port.ts";
import { isCoordinatorMainMethod } from "../shared/rpc/coordinator-main.ts";
import { SLATE_WEBAUTHN_HEARTBEAT_INTERVAL_MS, type WebAuthnCeremony } from "../shared/webauthn-gateway.ts";
import { createRealExpiryPolicy, createRealPollingPolicy, createRealRetryPolicy, realClock } from "../host/extensions/scheduling.ts";
import { adoptCarrier, type CarrierIntake, type CarrierIntakeHandlers } from "./carrier.ts";
import { ClientSideToolV2Relay } from "./client-side-tool-v2-relay.ts";
import { createControlPortClient } from "./control-port-client.ts";
import { CoordinatorGatewayClient, createCoordinatorGatewayClientTiming, HOST_ACCOUNT_SLOT, type GatewayConnection } from "./gateway/gateway-client.ts";
import { createGatewayDnsDiagnosticReporter } from "./gateway/gateway-dns-diagnostics.ts";
import { familyOnChannel } from "./gateway/gateway-event-families.ts";
import { createGatewayRequestDispatch } from "./gateway/gateway-request-dispatcher.ts";
import { createCoordinatorHostSupervisorTiming, SlateHostSupervisor } from "./gateway/host-supervisor.ts";
import { createCoordinatorInferenceRouter } from "./inference-router.ts";
import { createLocalExecDaemonRefreshPolicy, createLocalExecDaemonSupervisor } from "./local-exec/supervisor.ts";
import { McpOAuthForwarder } from "./oauth/mcp-oauth-forwarder.ts";
import { createRendererPortServer } from "./renderer-port-server.ts";
import { createTransportStageRecorder } from "./telemetry/transport-stage-recorder.ts";
import { createWebAuthnProvider } from "./webauthn/provider.ts";
import { createSpawnedWebAuthnSigner, resolveWebAuthnSignerPath } from "./webauthn/signer.ts";

const STDERR_PREFIX = "node-agent-coordinator: ";

export interface McpOAuthPending {
  readonly serverName: string;
  readonly redirectUrl: string;
  readonly state: string;
}

/** A pending OAuth ceremony, when the payload says all three things it has to say. */
export function asMcpOAuthPending(payload: unknown): McpOAuthPending | null {
  if (typeof payload !== "object" || payload == null) return null;
  const { serverName, redirectUrl, state } = payload as Record<string, unknown>;
  if (typeof serverName !== "string" || serverName.length === 0) return null;
  if (typeof redirectUrl !== "string" || redirectUrl.length === 0) return null;
  if (typeof state !== "string" || state.length === 0) return null;
  return { serverName, redirectUrl, state };
}

/** The user's own message coming back is what tells a send it landed; anything else is somebody else's event. */
export function recordEchoIfUserEcho(payload: unknown, recorder: { recordSendEcho(key: { accountSlot: string; clientNonce: string }): void }): void {
  if (typeof payload !== "object" || payload == null) return;
  const event = payload as { readonly type?: unknown; readonly entry?: Record<string, unknown> };
  if (event.type !== "appended") return;
  const entry = event.entry;
  if (typeof entry?.clientNonce !== "string" || entry.clientNonce.length === 0) return;
  const isUserEcho = (entry.kind === "message" && entry.role === "user") || entry.kind === "user-attachment";
  if (isUserEcho) recorder.recordSendEcho({ accountSlot: HOST_ACCOUNT_SLOT, clientNonce: entry.clientNonce });
}

/** How the WebAuthn signer is reconnected: as often as it takes, waiting a little longer each time. */
export function createWebAuthnReconnectPolicy() {
  return createRealRetryPolicy({ name: "slate-webauthn-reconnect", maxAttempts: Number.MAX_SAFE_INTEGER, initialDelayMs: 1_000, maxDelayMs: 30_000 });
}

type Commands = Record<string, (args: unknown) => Promise<unknown>>;

function command<T>(commands: Commands, method: string, args: unknown): Promise<T> {
  const invoke = commands[method];
  if (invoke === undefined) return Promise.reject(new Error(`control command ${method} is unavailable`));
  return invoke(args) as Promise<T>;
}

export interface ComposeCoordinatorDependencies {
  readonly adoptCarrier?: () => Promise<CarrierIntake>;
  readonly resolveSignerPath?: typeof resolveWebAuthnSignerPath;
}

export async function composeCoordinator(dependencies: ComposeCoordinatorDependencies = {}): Promise<void> {
  const carrierIntake = await (dependencies.adoptCarrier ?? adoptCarrier)();
  if (!carrierIntake.adopted) {
    // Without a carrier there is no process to be: the reason is the caller's, and the exit is not a success.
    process.stderr.write(`${STDERR_PREFIX}${carrierIntake.rejection.detail}\n`);
    process.exit(2);
  }
  const carrier = carrierIntake.carrier;
  const bootstrap = carrier.bootstrap;
  const controlClient = createControlPortClient({ post: (frame) => carrier.control.post(frame), close: () => carrier.control.close() });
  const commands = controlClient.commands;
  const recorder = createTransportStageRecorder({
    clock: realClock,
    egress: {
      reportTransportStage: (report) => command(commands, "reportTransportStage", report),
      reportGatewayCommandSpan: (report) => command(commands, "reportGatewayCommandSpan", report),
      reportGatewayReachability: (report) => command(commands, "reportGatewayReachability", report),
      reportGatewayDnsDiagnostic: (report) => command(commands, "reportGatewayDnsDiagnostic", report),
    },
  });
  const dnsDiagnostics = createGatewayDnsDiagnosticReporter((report) => recorder.recordGatewayDnsDiagnostic(report));
  const reportReachability = (report: unknown, baseUrl?: string): void => {
    recorder.recordGatewayReachability(report);
    dnsDiagnostics.observe(report as { outcome: string; causeSummary?: string }, baseUrl);
  };

  let isGatewayStreamLive = false;
  const hostSupervisor = new SlateHostSupervisor({
    resolveGatewayConnection: () => command(commands, "resolveGatewayConnection", {}),
    timing: createCoordinatorHostSupervisorTiming(),
    isTransportLive: () => isGatewayStreamLive,
    onReachability: reportReachability,
  });
  const oauthPendingHandlers = new Set<(pending: McpOAuthPending) => void>();
  let server: ReturnType<typeof createRendererPortServer>;
  let localExecSupervisor: ReturnType<typeof createLocalExecDaemonSupervisor>;
  const toolRelay = new ClientSideToolV2Relay((family, payload) => server.postEvent(family, payload));

  /** One event from the gateway's stream, sent where it belongs: a ceremony, an echo, the relay, or a surface. */
  function handleGatewaySseEvent(event: { channel: string; payload: unknown }): void {
    if (event.channel === "mcp-oauth-pending") {
      const pending = asMcpOAuthPending(event.payload);
      if (pending != null) for (const handler of oauthPendingHandlers) handler(pending);
      return;
    }
    if (event.channel === "transcript") recordEchoIfUserEcho(event.payload, recorder);
    if (event.channel === "client-side-tool-v2") {
      toolRelay.accept(event.payload);
      return;
    }
    if (event.channel === "agents") controlClient.postEvent("agents-event", { kind: "agents", event: event.payload });
    if (event.channel === "agent-upserted") controlClient.postEvent("agents-event", { kind: "agent-upserted", event: event.payload });
    const family = familyOnChannel(event.channel);
    if (family != null) server.postEvent(family, event.payload);
  }

  /** What the host's agent roster is, handed to the main port as soon as the stream is up. */
  async function seedAgentsRosterToMain(): Promise<void> {
    try {
      const agents = await gatewayClient.dispatchCommand("listAgents", {});
      controlClient.postEvent("agents-roster-seed", { agents });
    } catch (error) {
      // A roster that could not be read is a seed that was skipped, not a reason to take the stream down.
      process.stderr.write(`${STDERR_PREFIX}agents roster seed skipped: ${String(error)}\n`);
    }
  }

  /** The transport's own state: told to the main port, and the local-exec daemon refreshed with it. */
  function handleTransportEvent(raw: unknown): void {
    if (typeof raw !== "object" || raw == null) return;
    const event = raw as { family: string; payload: unknown };
    controlClient.postEvent(event.family, event.payload);
    if (event.family === "transport-down") {
      isGatewayStreamLive = false;
      hostSupervisor.invalidateHealthCache();
      server.postEvent(COORDINATOR_TRANSPORT_STATE_FAMILY, { state: "down" });
      return;
    }
    isGatewayStreamLive = true;
    void localExecSupervisor.refreshConnection();
    void seedAgentsRosterToMain();
    server.postEvent(COORDINATOR_TRANSPORT_STATE_FAMILY, { state: "connected" });
  }

  const gatewayClient = new CoordinatorGatewayClient({
    resolveConnection: (signal) => hostSupervisor.ensureConnection(signal) as Promise<GatewayConnection>,
    onEvent: handleGatewaySseEvent,
    onTransportEvent: handleTransportEvent,
    onTransportRetry: () => hostSupervisor.invalidateHealthCache(),
    recordTransportStage: (report) => recorder.recordTransportStage(report as Parameters<typeof recorder.recordTransportStage>[0]),
    onReachability: reportReachability,
    resolveTraceWindowTraceparent: () => command(commands, "getRpcTraceWindowTraceparent", {}),
    recordGatewayCommandSpan: (report) => recorder.recordGatewayCommandSpan(report),
    timing: createCoordinatorGatewayClientTiming(),
  });

  const oauthForwarder = new McpOAuthForwarder({
    pendingEvents: {
      subscribe(handler) {
        oauthPendingHandlers.add(handler);
        return { dispose() { oauthPendingHandlers.delete(handler); } };
      },
    },
    completion: { completeMcpOAuth: (args) => gatewayClient.dispatchLegacyCommand("completeMcpOAuth", args) },
    log: { warn(warning) { process.stderr.write(`${STDERR_PREFIX}mcp-oauth ${JSON.stringify(warning)}\n`); } },
    pendingExpiry: createRealExpiryPolicy({ name: "mcp-oauth-pending", ttlMs: 10 * 60_000 }),
  });

  localExecSupervisor = createLocalExecDaemonSupervisor({
    control: {
      resolveGatewayConnection: (args) => command(commands, "resolveGatewayConnection", args),
      mintLocalExecDaemonCredential: (args) => command(commands, "mintLocalExecDaemonCredential", args),
      spawnLocalExecDaemon: (args) => command(commands, "spawnLocalExecDaemon", args),
      isProcessAlive: (args) => command(commands, "isProcessAlive", args),
      getProcessIdentity: (args) => command(commands, "getProcessIdentity", args),
      waitLocalExecDaemonExit: (args) => command(commands, "waitLocalExecDaemonExit", args),
      terminateProcess: (args) => command(commands, "terminateProcess", args),
    },
    dataDir: bootstrap.processConfig.dataDir,
    isPackaged: bootstrap.processConfig.isPackaged,
    refreshPolicy: createLocalExecDaemonRefreshPolicy(),
  });

  // A signer is only there to spawn when this build ships one.
  let webauthnProvider: ReturnType<typeof createWebAuthnProvider> | undefined;
  const signerPath = (dependencies.resolveSignerPath ?? resolveWebAuthnSignerPath)({ isPackaged: bootstrap.processConfig.isPackaged });
  if (signerPath !== undefined) {
    const reportProgress = (status: string): void => { void command(commands, "updateWebAuthnConsent", { status }); };
    webauthnProvider = createWebAuthnProvider({
      resolveConnection: () => command(commands, "resolveGatewayConnection", {}),
      consent: {
        requestConsent: async (ceremony: WebAuthnCeremony) => {
          const optionsJson = ceremony.optionsJson;
          const options = typeof optionsJson === "string" ? JSON.parse(optionsJson) as { rpId?: string; rp?: { id?: string } } : {};
          return await command(commands, "requestWebAuthnConsent", { origin: ceremony.origin, rpId: options.rpId ?? options.rp?.id ?? ceremony.origin });
        },
        finish: () => { void command(commands, "finishWebAuthnConsent", {}); },
      },
      signer: createSpawnedWebAuthnSigner({
        binaryPath: signerPath,
        onStatus: reportProgress,
        onPinRequest: async (request, promptId) => {
          const result = await command<{ pin?: string | null }>(commands, "requestWebAuthnPin", { promptId, invalid: request.invalid, ...(request.retries === undefined ? {} : { retries: request.retries }) });
          return result.pin ?? undefined;
        },
      }),
      heartbeatPolicy: createRealPollingPolicy({ name: "slate-webauthn-heartbeat", intervalMs: SLATE_WEBAUTHN_HEARTBEAT_INTERVAL_MS }),
      reconnectPolicy: createWebAuthnReconnectPolicy(),
      deliveryPolicy: createRealRetryPolicy({ name: "slate-webauthn-delivery", maxAttempts: 5, initialDelayMs: 250, maxDelayMs: 4_000 }),
      label: hostname(),
    });
    webauthnProvider.start();
  }

  const gatewayDispatch = createGatewayRequestDispatch(gatewayClient);
  const inferenceRouter = createCoordinatorInferenceRouter({
    dataDir: bootstrap.processConfig.dataDir,
    postEvent: (family, payload) => server.postEvent(family, payload),
    // The router's own tools are the host's; everything else is the gateway's.
    dispatchRemote: (method, args) => method === "listRoutedMcpTools"
      ? command(commands, "listRoutedMcpTools", args)
      : method === "executeRoutedMcpTool"
        ? command(commands, "executeRoutedMcpTool", args)
        : gatewayClient.dispatchCommand(method, args),
  });
  /** A request from the renderer: the router answers what it owns, the gateway gets the rest. */
  const dispatchRequest = async (method: string, args: unknown, signal: AbortSignal) => {
    if (method === "sendPrompt" && typeof args === "object" && args != null) {
      const { clientNonce, traceparent } = args as Record<string, unknown>;
      recorder.beginSend({ accountSlot: HOST_ACCOUNT_SLOT, clientNonce: typeof clientNonce === "string" ? clientNonce : null, traceparent: typeof traceparent === "string" ? traceparent : null });
    }
    const routed = await inferenceRouter.dispatch(method, args);
    return routed.handled ? { status: "ok" as const, value: routed.value } : await gatewayDispatch(method, args, signal);
  };
  server = createRendererPortServer(
    { post: (frame) => carrier.data.post(frame), close: () => carrier.data.close() },
    {
      dispatchRequest,
      onServing: () => {
        toolRelay.replay();
        // A renderer that arrives before the gateway is up is told so rather than left guessing.
        if (!isGatewayStreamLive) server.postEvent(COORDINATOR_TRANSPORT_STATE_FAMILY, { state: "down" });
      },
    },
  );
  const mainDispatch = createGatewayRequestDispatch(gatewayClient, isCoordinatorMainMethod);
  /** The main port may ask for the gateway to be paused, which also stops the ceremonies. */
  const applyPause = (paused: boolean): void => {
    void localExecSupervisor.setPaused(paused);
    if (paused) webauthnProvider?.stop(); else webauthnProvider?.start();
  };
  const mainServer = createRendererPortServer(
    { post: (frame) => carrier.mainData.post(frame), close: () => carrier.mainData.close() },
    {
      dispatchRequest: (method, args, signal) => {
        if (method === "setGatewayPaused" && typeof args === "object" && args != null) applyPause((args as Record<string, unknown>).paused === true);
        return mainDispatch(method, args, signal);
      },
    },
  );

  let exitSettled = false;
  /** The one place the process ends: everything let go, then the carrier's own exit. */
  function settleProcess(exitCode: number): void {
    if (exitSettled) return;
    exitSettled = true;
    gatewayClient.close();
    toolRelay.clear();
    localExecSupervisor.dispose();
    oauthForwarder.dispose();
    controlClient.shutdown();
    server.handlePortClosed();
    mainServer.handlePortClosed();
    carrier.control.close();
    carrier.data.close();
    carrier.mainData.close();
    carrier.exitProcess(exitCode);
  }
  // A port that broke its protocol is a failure of the process, not a quiet end.
  void server.settled.then((settlement) => {
    if (settlement.outcome === "protocol-breach") {
      process.stderr.write(`${STDERR_PREFIX}protocol breach: ${settlement.detail}\n`);
      settleProcess(1);
    } else settleProcess(0);
  });
  void mainServer.settled.then((settlement) => {
    if (settlement.outcome === "protocol-breach") {
      process.stderr.write(`${STDERR_PREFIX}main-data protocol breach: ${settlement.detail}\n`);
      settleProcess(1);
    } else settleProcess(0);
  });
  void controlClient.settled.then((settlement) => {
    if (settlement.outcome === "protocol-breach") {
      process.stderr.write(`${STDERR_PREFIX}control protocol breach: ${settlement.detail}\n`);
      settleProcess(1);
    } else settleProcess(0);
  });
  /** A crash is written down through the control port before the process goes, so the reason outlives it. */
  const settleOnCrash = (kind: "uncaughtException" | "unhandledRejection", value: unknown): void => {
    const error = value instanceof Error ? value : new Error(String(value));
    process.stderr.write(`${STDERR_PREFIX}${kind}: ${error.stack ?? String(error)}\n`);
    void command(commands, "reportProcessCrash", { kind, errorName: error.name, errorMessage: error.message, errorStack: error.stack ?? null })
      .catch((reportError) => process.stderr.write(`${STDERR_PREFIX}crash report undelivered: ${String(reportError)}\n`));
    settleProcess(1);
  };
  process.on("uncaughtException", (value) => settleOnCrash("uncaughtException", value));
  process.on("unhandledRejection", (value) => settleOnCrash("unhandledRejection", value));

  const handlers: CarrierIntakeHandlers = {
    onControlFrame: (frame) => controlClient.handleMessage(frame),
    onDataFrame: (value) => server.handleMessage(value),
    onMainDataFrame: (value) => mainServer.handleMessage(value),
    onClosed: () => {
      controlClient.handlePortClosed();
      server.handlePortClosed();
      mainServer.handlePortClosed();
    },
  };
  carrier.bind(handlers);
  void localExecSupervisor.start();
  gatewayClient.start();
}

// Run as the coordinator entry point, and only then.
const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  void composeCoordinator().catch((error) => {
    process.stderr.write(`${STDERR_PREFIX}composition failure: ${String(error)}\n`);
    process.exit(1);
  });
}
