/**
 * The host process: one entry point, two modes, and a shutdown that cannot hang forever.
 *
 * This file owns the order of the process graph, not the graph itself: the guards are installed, the lock taken, the
 * box-exec daemon brought up, the host started, and the gateway handed the host's API. The dependencies are injected,
 * so the whole graph can be exercised without spawning a process.
 *
 * Three rules decide what happens when a step does not go well:
 *
 * - the copy-in helper fails closed: a bad environment or a failed copy exits non-zero, after one log line;
 * - a startup failure reports the crash, flushes telemetry, cleans up the daemon and releases the lock, in that order,
 *   and only then exits non-zero;
 * - a shutdown that overruns its watchdog reports itself, flushes what it can, releases the lock and exits non-zero —
 *   a process that looks alive but is not is worse than one that fails.
 */
import { join } from "node:path";
import { installInvariantReporter } from "../shared/invariant.ts";
import { gatewayScheme, resolveGatewayServerConfig } from "../gateway/gateway-config.ts";
import { startGatewayServer } from "../gateway/gateway-server.ts";
import { clearGatewayDiscovery, writeGatewayDiscovery } from "./host-discovery.ts";
import { pinHostDiagnosticsReporter } from "./host-diagnostics.ts";
import { acquireHostLock } from "./host-lock.ts";
import { getSlateRootDir } from "./host-paths.ts";
import { installProcessCrashGuards } from "./process-crash-guard.ts";
import { createProductionSlateHost, type ProductionSlateHostPorts } from "./slate-host.ts";
import { launchBoxExecDaemon, resolveBoxDaemonEntryFromHost, type HostOwnedBoxExecDaemon } from "./boxes/exec-daemon-process.ts";

export const BOX_COPY_IN_ARG = "--box-copy-in";
export const BOX_COPY_IN_EXIT_FAILED = 1;
export const SHUTDOWN_WATCHDOG_MS = 5_000;

/** What the process is, from the outside: its arguments, its pid and the two ways it can end. */
export type HostProcessControl = {
  on(signal: "SIGTERM" | "SIGINT", listener: () => void): void;
  exit(code: number): void;
  readonly pid: number;
  readonly argv: readonly string[];
};

/** The one lock the host holds for as long as it owns its root. */
export type HostLock = {
  release(): void;
};

/** How taking the lock went, and what it replaced. */
export type HostLockResult = {
  readonly outcome: string;
  readonly lock: HostLock;
  readonly previousPid?: number;
};

/** What the gateway needs to listen: where, on what port, and under which credentials. */
export type GatewayServerConfig = {
  readonly host: string;
  readonly tls?: unknown;
  readonly port?: number;
  readonly authToken?: string;
};

/** A gateway that is listening and can be closed. */
export type StartedGateway = {
  readonly port: number;
  close(): Promise<void>;
};

/** The host the process starts and reports through: its lifecycle, its API and the failures it takes. */
export interface HostMainHost {
  readonly startedAt: number;
  start(): Promise<void>;
  dispose(): Promise<void>;
  getApi(): unknown;
  subscribe(listener: (event: unknown) => void): () => void;
  getHealth(): unknown;
  getLocalExecBridge(): unknown;
  getWebAuthnBridge(): unknown;
  noteEventStreamClosed(): void;
  noteDesktopContact(): void;
  prepareForUpgrade(): Promise<unknown>;
  reportProcessCrash(error: unknown, kind: string): void;
  reportInvariantViolation(report: unknown): void;
  reportHostDiagnostic(diagnostic: unknown): void;
  reportGatewayCommandError(report: unknown): void;
  reportGatewayCommandSuccess(report: unknown): void;
  flushTelemetryForFatalExit(): Promise<void>;
  reportBoxReady(): Promise<void>;
}

/** The crash guards as the host sees them: they are installed once and given a reporter. */
export interface ProcessCrashGuards {
  setReporter(reporter: (error: unknown, kind: string) => void): void;
}

/** Everything the process graph needs from the outside, one function per external decision. */
export type HostMainDependencies = {
  readonly executeBoxCopyInFromEnv: () => Promise<number>;
  readonly startBoxExecDaemon?: () => Promise<HostOwnedBoxExecDaemon>;
  readonly acquireHostLock: () => Promise<HostLockResult>;
  readonly getSlateRootDir: () => string;
  readonly createHost: () => HostMainHost;
  readonly resolveGatewayServerConfig: () => GatewayServerConfig;
  readonly gatewayScheme: (config: GatewayServerConfig) => string;
  readonly startGatewayServer: (options: {
    readonly subscribe: (listener: (event: unknown) => void) => () => void;
    readonly getHealth: () => unknown;
    readonly api: unknown;
    readonly startedAt: number;
    readonly host: string;
    readonly port?: number;
    readonly authToken?: string;
    readonly tls?: unknown;
    readonly localExec: unknown;
    readonly webauthn: unknown;
    readonly onEventStreamClosed: () => void;
    readonly onDesktopContact: () => void;
    readonly prepareForUpgrade: () => Promise<unknown>;
    readonly onCommandError: (report: unknown) => void;
    readonly onCommandComplete: (report: unknown) => void;
  }) => Promise<StartedGateway>;
  readonly writeGatewayDiscovery: (discovery: { readonly token?: string; readonly host: string; readonly scheme: string; readonly startedAt: number; readonly pid: number; readonly port: number }) => Promise<void>;
  readonly clearGatewayDiscovery: () => Promise<void>;
  readonly installProcessCrashGuards: (options: { readonly scope: "slate-host" }) => ProcessCrashGuards;
  readonly installInvariantReporter: (reporter: (report: unknown) => void) => void;
  readonly pinHostDiagnosticsReporter: (reporter: (diagnostic: unknown) => void) => void;
  readonly log?: Pick<Console, "log" | "error">;
};

/** The recovered box-store composition supplies the copy-in bootstrap, so it is a port rather than an import. */
export type HostProductionPorts = ProductionSlateHostPorts & {
  executeBoxCopyInFromEnv(): Promise<number>;
};

/** How this module writes its own lines and reads its own switches. */
const HOST_LOG_PREFIX = "[slate-host]";
const COPY_IN_LOG_PREFIX = "[box-copy-in]";
const EXISTING_BOX_EXEC_DAEMON_ENV = "SLATE_USE_EXISTING_BOX_EXEC_DAEMON";
const LOCK_TAKEN_OVER = "took-over";
const WORKSPACE_DIRECTORY_NAME = "box-workspace";
const TERMINALS_DIRECTORY_NAME = "box-terminals";

/** The crash kinds the process reports, named once because a log reader searches for them. */
const CRASH_KINDS = {
  fatalStartup: "fatal_startup",
  daemonStartupCleanup: "box_exec_daemon_startup_cleanup",
  shutdownWatchdog: "shutdown_watchdog",
  shutdownError: "shutdown_error",
} as const;

/** Whether the deployment runs its own box-exec daemon, which this process must not start. */
function usesExistingBoxExecDaemon(): boolean {
  return process.env[EXISTING_BOX_EXEC_DAEMON_ENV] === "1";
}

/** The part of the graph that starts the box-exec daemon, or nothing when the deployment owns it. */
function boxExecDaemonStarter(ports: HostProductionPorts, useExisting: boolean): { startBoxExecDaemon?: () => Promise<HostOwnedBoxExecDaemon> } {
  if (useExisting) return {};
  return {
    startBoxExecDaemon: async () => {
      const daemon = launchBoxExecDaemon({
        daemonEntryPath: resolveBoxDaemonEntryFromHost(),
        rpcPorts: ports.extensionHost.boxGenerated,
        workspaceDirectory: join(getSlateRootDir(), WORKSPACE_DIRECTORY_NAME),
        terminalDirectory: join(getSlateRootDir(), TERMINALS_DIRECTORY_NAME),
        ...(ports.log === undefined ? {} : { output: ports.log }),
      });
      return daemon;
    },
  };
}

/** The host factory for a packaged entry point: the ports it was handed, plus who owns the daemon. */
function productionHostFactory(ports: HostProductionPorts, useExisting: boolean): () => HostMainHost {
  return () => createProductionSlateHost({
    ...ports,
    extensionHost: {
      ...ports.extensionHost,
      standaloneBoxExecDaemon: !useExisting,
    },
  });
}

/** The dependency graph a packaged host entry runs with: the real process, wired from explicit ports. */
export function createProductionHostMainDependencies(ports: HostProductionPorts): HostMainDependencies {
  const useExisting = usesExistingBoxExecDaemon();
  return {
    executeBoxCopyInFromEnv: ports.executeBoxCopyInFromEnv,
    installProcessCrashGuards: (options) => installProcessCrashGuards(options),
    installInvariantReporter: (reporter) => {
      void installInvariantReporter(reporter);
    },
    pinHostDiagnosticsReporter: (reporter) => pinHostDiagnosticsReporter(reporter as Parameters<typeof pinHostDiagnosticsReporter>[0]),
    acquireHostLock,
    getSlateRootDir,
    createHost: productionHostFactory(ports, useExisting),
    resolveGatewayServerConfig,
    gatewayScheme: (config) => gatewayScheme(config as Parameters<typeof gatewayScheme>[0]),
    startGatewayServer: (options) => startGatewayServer(options as Parameters<typeof startGatewayServer>[0]),
    writeGatewayDiscovery: (discovery) => writeGatewayDiscovery({ ...discovery, scheme: discovery.scheme as "http" | "https" }),
    clearGatewayDiscovery,
    ...(ports.log === undefined ? {} : { log: ports.log }),
    ...boxExecDaemonStarter(ports, useExisting),
  };
}

/** Starts the concrete clean-source host graph from explicit generated ports. */
export function startProductionHost(ports: HostProductionPorts, processControl: HostProcessControl = defaultProcessControl): Promise<void> {
  return main(createProductionHostMainDependencies(ports), processControl);
}

/** The only thing a shutdown registration can do: shut down, however it was asked. */
export type ShutdownRegistration = {
  shutdown(signal: "SIGTERM" | "SIGINT"): void;
};

/** This process, seen through the control interface: the defaults the entry point uses. */
function currentProcessControl(): HostProcessControl {
  return {
    argv: process.argv,
    pid: process.pid,
    on: (signal, listener) => process.on(signal, listener),
    exit: (code) => process.exit(code),
  };
}

const defaultProcessControl: HostProcessControl = currentProcessControl();

/** Whether this invocation is the box-copy helper rather than a host. */
function isBoxCopyInInvocation(argv: readonly string[]): boolean {
  return argv.includes(BOX_COPY_IN_ARG);
}

/** Run the copy-in helper and exit with what it said; a failure is logged and fails closed. */
async function runBoxCopyIn(
  deps: Pick<HostMainDependencies, "executeBoxCopyInFromEnv">,
  processControl: HostProcessControl,
  log: Pick<Console, "error">,
): Promise<void> {
  let code: number;
  try {
    code = await deps.executeBoxCopyInFromEnv();
  } catch (error) {
    log.error(`${COPY_IN_LOG_PREFIX} unexpected error (failing closed):`, error);
    code = BOX_COPY_IN_EXIT_FAILED;
  }
  processControl.exit(code);
}

/** Give the host the three reporters the process graph installs: crashes, invariants and diagnostics. */
function wireProcessReporters(host: HostMainHost, crashGuards: ProcessCrashGuards, deps: HostMainDependencies): void {
  crashGuards.setReporter((error, kind) => {
    host.reportProcessCrash(error, kind);
  });
  deps.installInvariantReporter((report) => host.reportInvariantViolation(report));
  deps.pinHostDiagnosticsReporter((diagnostic) => {
    host.reportHostDiagnostic(diagnostic);
  });
}

/** What the gateway is started with: the host's API and bridges, and the config's optional parts only if present. */
function gatewayStartOptions(host: HostMainHost, config: GatewayServerConfig): Parameters<HostMainDependencies["startGatewayServer"]>[0] {
  return {
    api: host.getApi(),
    subscribe: (listener) => host.subscribe(listener),
    getHealth: () => host.getHealth(),
    onEventStreamClosed: () => host.noteEventStreamClosed(),
    onDesktopContact: () => host.noteDesktopContact(),
    prepareForUpgrade: () => host.prepareForUpgrade(),
    startedAt: host.startedAt,
    host: config.host,
    localExec: host.getLocalExecBridge(),
    webauthn: host.getWebAuthnBridge(),
    onCommandError: (report) => host.reportGatewayCommandError(report),
    onCommandComplete: (report) => host.reportGatewayCommandSuccess(report),
    ...(config.port === undefined ? {} : { port: config.port }),
    ...(config.authToken === undefined ? {} : { authToken: config.authToken }),
    ...(config.tls === undefined ? {} : { tls: config.tls }),
  };
}

/** The discovery record another process reads to find this host's gateway. */
function gatewayDiscoveryRecord(
  port: number,
  pid: number,
  startedAt: number,
  scheme: string,
  config: GatewayServerConfig,
): Parameters<HostMainDependencies["writeGatewayDiscovery"]>[0] {
  return {
    port,
    pid,
    startedAt,
    scheme,
    host: config.host,
    ...(config.authToken === undefined ? {} : { token: config.authToken }),
  };
}

/** The one line that says the gateway came up, and whether it wants a token. */
function logGatewayListening(log: Pick<Console, "log">, scheme: string, config: GatewayServerConfig, port: number): void {
  log.log(
    `${HOST_LOG_PREFIX} gateway listening on ${scheme}://${config.host}:${port}` +
    (config.authToken != null ? " (auth required)" : ""),
  );
}

/** A startup that failed: report it, flush, clean up the daemon, release the lock, exit non-zero — in that order. */
async function handleStartupFailure(
  host: HostMainHost,
  hostLock: HostLock,
  processControl: HostProcessControl,
  boxExecDaemon: HostOwnedBoxExecDaemon | undefined,
  error: unknown,
): Promise<void> {
  host.reportProcessCrash(error, CRASH_KINDS.fatalStartup);
  await host.flushTelemetryForFatalExit();
  await boxExecDaemon?.close().catch((closeError) => host.reportProcessCrash(closeError, CRASH_KINDS.daemonStartupCleanup));
  hostLock.release();
  processControl.exit(1);
}

/** The long-lived host: lock it, start it, sell it to the gateway, then wait for a signal to shut down. */
async function runHostProcess(
  deps: HostMainDependencies,
  processControl: HostProcessControl,
  log: Pick<Console, "log" | "error">,
): Promise<void> {
  const crashGuards = deps.installProcessCrashGuards({ scope: "slate-host" });
  const lockResult = await deps.acquireHostLock();
  reportLockOutcome(lockResult, deps.getSlateRootDir(), log);

  const hostLock = lockResult.lock;
  let boxExecDaemon: HostOwnedBoxExecDaemon | undefined;
  const host = deps.createHost();
  wireProcessReporters(host, crashGuards, deps);

  try {
    boxExecDaemon = await deps.startBoxExecDaemon?.();
    await host.start();
    const gatewayConfig = deps.resolveGatewayServerConfig();
    const scheme = deps.gatewayScheme(gatewayConfig);
    const gateway = await deps.startGatewayServer(gatewayStartOptions(host, gatewayConfig));

    await deps.writeGatewayDiscovery(gatewayDiscoveryRecord(gateway.port, processControl.pid, host.startedAt, scheme, gatewayConfig));
    logGatewayListening(log, scheme, gatewayConfig, gateway.port);

    installShutdownHandlers(host, gateway, hostLock, deps.clearGatewayDiscovery, processControl, log, SHUTDOWN_WATCHDOG_MS, boxExecDaemon);
    void host.reportBoxReady();
  } catch (error) {
    await handleStartupFailure(host, hostLock, processControl, boxExecDaemon, error);
  }
}

/** The process, from the first argument to the last exit code. */
export async function main(deps: HostMainDependencies, processControl: HostProcessControl = defaultProcessControl): Promise<void> {
  const log = deps.log ?? console;
  if (isBoxCopyInInvocation(processControl.argv)) {
    await runBoxCopyIn(deps, processControl, log);
    return;
  }
  await runHostProcess(deps, processControl, log);
}

/** The one line a notable lock outcome deserves, or null for a plain acquisition. */
function lockOutcomeLine(result: HostLockResult, slateRootDir: string): string | null {
  if (result.outcome === LOCK_TAKEN_OVER) {
    return `${HOST_LOG_PREFIX} took over ${slateRootDir} from live host pid ${result.previousPid}`;
  }
  if (result.previousPid != null) {
    return `${HOST_LOG_PREFIX} reclaimed ${slateRootDir} lock (${result.outcome}) from pid ${result.previousPid}`;
  }
  return null;
}

/** A lock taken from a live host, or reclaimed from one that died, is worth one line: it explains the gap. */
export function reportLockOutcome(result: HostLockResult, slateRootDir: string, log: Pick<Console, "log">): void {
  const line = lockOutcomeLine(result, slateRootDir);
  if (line !== null) log.log(line);
}

/** The shutdown watchdog: a shutdown that overruns its budget reports itself, flushes and exits non-zero. */
function armShutdownWatchdog(
  host: Pick<HostMainHost, "reportProcessCrash" | "flushTelemetryForFatalExit">,
  hostLock: HostLock,
  processControl: HostProcessControl,
  watchdogMs: number,
): ReturnType<typeof setTimeout> {
  const watchdog = setTimeout(() => {
    host.reportProcessCrash(null, CRASH_KINDS.shutdownWatchdog);
    void host.flushTelemetryForFatalExit().finally(() => {
      hostLock.release();
      processControl.exit(1);
    });
  }, watchdogMs);
  watchdog.unref();
  return watchdog;
}

/** Close the gateway, dispose the host, stop the daemon and clear discovery; a failure is reported and flushed. */
async function drainBeforeExit(session: {
  readonly host: Pick<HostMainHost, "dispose" | "reportProcessCrash" | "flushTelemetryForFatalExit">,
  readonly gateway: Pick<StartedGateway, "close">,
  readonly hostLock: HostLock,
  readonly clearGatewayDiscovery: () => Promise<void>,
  readonly processControl: HostProcessControl,
  readonly watchdog: ReturnType<typeof setTimeout>,
  readonly boxExecDaemon: HostOwnedBoxExecDaemon | undefined,
}): Promise<void> {
  const { host, gateway, hostLock, clearGatewayDiscovery, processControl, watchdog, boxExecDaemon } = session;
  try {
    await gateway.close();
    await host.dispose();
    await boxExecDaemon?.close();
    await clearGatewayDiscovery();
  } catch (error) {
    host.reportProcessCrash(error, CRASH_KINDS.shutdownError);
    await host.flushTelemetryForFatalExit();
  } finally {
    clearTimeout(watchdog);
    hostLock.release();
    processControl.exit(0);
  }
}

/**
 * Shutdown, once.
 *
 * The gateway closes first, so no new command arrives while the host goes away, then the host disposes and the box
 * daemon closes; discovery is cleared last. The lock is released in every path. A shutdown that overruns its watchdog
 * reports itself and exits non-zero — a process that hangs is worse than one that fails.
 */
export function installShutdownHandlers(
  host: Pick<HostMainHost, "dispose" | "reportProcessCrash" | "flushTelemetryForFatalExit">,
  gateway: Pick<StartedGateway, "close">,
  hostLock: HostLock,
  clearGatewayDiscovery: () => Promise<void>,
  processControl: HostProcessControl = defaultProcessControl,
  log: Pick<Console, "log"> = console,
  watchdogMs = SHUTDOWN_WATCHDOG_MS,
  boxExecDaemon?: HostOwnedBoxExecDaemon,
): ShutdownRegistration {
  let isShuttingDown = false;

  const shutdown = (signal: "SIGTERM" | "SIGINT") => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    log.log(`${HOST_LOG_PREFIX} received ${signal}, shutting down`);
    const watchdog = armShutdownWatchdog(host, hostLock, processControl, watchdogMs);
    void drainBeforeExit({ host, gateway, hostLock, clearGatewayDiscovery, processControl, watchdog, boxExecDaemon });
  };

  for (const signal of ["SIGTERM", "SIGINT"] as const) processControl.on(signal, () => shutdown(signal));
  return { shutdown };
}
