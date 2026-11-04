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
import { ClientSideToolV2Relay } from "../adapters/interop/agent/client-side-tool-v2-relay-adapter.ts";
import { createControlPortClient } from "./control-port-client.ts";
import { CoordinatorGatewayClient, createCoordinatorGatewayClientTiming, HOST_ACCOUNT_SLOT, type GatewayConnection } from "./gateway/gateway-client.ts";
import { createGatewayDnsDiagnosticReporter } from "./gateway/gateway-dns-diagnostics.ts";
import { createGatewayRequestDispatch } from "./gateway/gateway-request-dispatcher.ts";
import { createCoordinatorHostSupervisorTiming, SlateHostSupervisor } from "./gateway/host-supervisor.ts";
import { createCoordinatorInferenceRouter } from "./inference-router.ts";
import { createLocalExecDaemonRefreshPolicy, createLocalExecDaemonSupervisor } from "./local-exec/supervisor.ts";
import { McpOAuthForwarder } from "./oauth/mcp-oauth-forwarder.ts";
import { createRendererPortServer } from "./renderer-port-server.ts";
import { createTransportStageRecorder } from "./telemetry/transport-stage-recorder.ts";
import { createWebAuthnProvider } from "./webauthn/provider.ts";
import { createSpawnedWebAuthnSigner, resolveWebAuthnSignerPath } from "./webauthn/signer.ts";
import { webAuthnReconnectSchedule, type PendingMcpAuthorization } from "./main-policies.ts";
import { applyCoordinatorTransportSignal, routeCoordinatorGatewayNotice, seedCoordinatorAgentRoster } from "./main-gateway-events.ts";
import { createCoordinatorCrashHandler, createCoordinatorStopHandler, observeCoordinatorPort } from "./main-lifecycle.ts";

const STDERR_PREFIX = "node-agent-coordinator: ";

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
  const oauthPendingHandlers = new Set<(pending: PendingMcpAuthorization) => void>();
  let server: ReturnType<typeof createRendererPortServer>;
  let localExecSupervisor: ReturnType<typeof createLocalExecDaemonSupervisor>;
  const toolRelay = new ClientSideToolV2Relay((family, payload) => server.postEvent(family, payload));

  const gatewayClient = new CoordinatorGatewayClient({
    resolveConnection: (signal) => hostSupervisor.ensureConnection(signal) as Promise<GatewayConnection>,
    onEvent: (event) => routeCoordinatorGatewayNotice(event, {
      authorizationListeners: oauthPendingHandlers,
      echoRecorder: recorder,
      toolRelay,
      controlEvents: controlClient,
      rendererEvents: server,
    }),
    onTransportEvent: (event) => {
      const streamLive = applyCoordinatorTransportSignal(event, {
        controlEvents: controlClient,
        invalidateHealth: () => hostSupervisor.invalidateHealthCache(),
        refreshLocalExec: () => localExecSupervisor.refreshConnection(),
        seedAgentRoster: () => seedCoordinatorAgentRoster(
          () => gatewayClient.dispatchCommand("listAgents", {}),
          (family, payload) => controlClient.postEvent(family, payload),
          (message) => process.stderr.write(`${STDERR_PREFIX}${message}\n`),
        ),
        rendererEvents: server,
      });
      if (streamLive !== undefined) isGatewayStreamLive = streamLive;
    },
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
      reconnectPolicy: webAuthnReconnectSchedule(),
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

  const stopCoordinator = createCoordinatorStopHandler({
    closeGateway: () => gatewayClient.close(),
    clearToolRelay: () => toolRelay.clear(),
    disposeLocalExec: () => localExecSupervisor.dispose(),
    disposeOAuthForwarder: () => oauthForwarder.dispose(),
    stopControlPort: () => controlClient.shutdown(),
    closeRendererPort: () => server.handlePortClosed(),
    closeMainPort: () => mainServer.handlePortClosed(),
    closeCarrierControl: () => carrier.control.close(),
    closeCarrierData: () => carrier.data.close(),
    closeCarrierMainData: () => carrier.mainData.close(),
    exitProcess: (code) => carrier.exitProcess(code),
  });
  const report = (message: string): void => { process.stderr.write(message); };
  observeCoordinatorPort(server.settled, {
    prefix: STDERR_PREFIX,
    breachLabel: "protocol breach",
    report,
    stop: stopCoordinator,
  });
  observeCoordinatorPort(mainServer.settled, {
    prefix: STDERR_PREFIX,
    breachLabel: "main-data protocol breach",
    report,
    stop: stopCoordinator,
  });
  observeCoordinatorPort(controlClient.settled, {
    prefix: STDERR_PREFIX,
    breachLabel: "control protocol breach",
    report,
    stop: stopCoordinator,
  });
  const onCoordinatorCrash = createCoordinatorCrashHandler({
    prefix: STDERR_PREFIX,
    report,
    submitReport: (crash) => command(commands, "reportProcessCrash", crash),
    stop: stopCoordinator,
  });
  process.on("uncaughtException", (value) => onCoordinatorCrash("uncaughtException", value));
  process.on("unhandledRejection", (value) => onCoordinatorCrash("unhandledRejection", value));

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
