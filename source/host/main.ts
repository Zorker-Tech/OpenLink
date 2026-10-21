/**
 * The host process: one entry point, two modes, and a shutdown that cannot hang forever.
 *
 * The entry point does very little of its own work — it installs the guards, takes the host lock, brings the box-exec
 * daemon up, starts the host, and hands the gateway the host's API. What this file owns is the *order* and what happens
 * when a step fails:
 *
 * - **the copy-in mode fails closed** — a bad environment or a failed copy exits non-zero with a report, because that
 *   helper runs inside a box that expects a file copied in or an error;
 * - **startup failures exit the process** — after reporting the crash, flushing telemetry, cleaning up the daemon and
 *   releasing the lock, in that order;
 * - **shutdown has a watchdog** — a shutdown that cannot finish within its budget reports itself, flushes what it can,
 *   releases the lock and exits non-zero rather than leaving a process that looks alive but is not.
 *
 * The dependencies are handed in rather than imported so the whole process graph can be exercised without spawning one.
 */
import { installInvariantReporter } from "../shared/invariant.ts";
import { gatewayScheme, resolveGatewayServerConfig } from "../gateway/gateway-config.ts";
import { startGatewayServer } from "../gateway/gateway-server.ts";
import { clearGatewayDiscovery, writeGatewayDiscovery } from "./host-discovery.ts";
import { pinHostDiagnosticsReporter } from "./host-diagnostics.ts";
import { acquireHostLock } from "./host-lock.ts";
import { getSlateRootDir } from "./host-paths.ts";
import path from "node:path";
import { installProcessCrashGuards } from "./process-crash-guard.ts";
import { createProductionSlateHost, type ProductionSlateHostPorts } from "./slate-host.ts";
import { resolveBoxExecDaemonEntry, startBoxExecDaemonProcess, type OwnedBoxExecDaemon } from "./boxes/exec-daemon-process.ts";

export const BOX_COPY_IN_ARG = "--box-copy-in";
export const BOX_COPY_IN_EXIT_FAILED = 1;
export const SHUTDOWN_WATCHDOG_MS = 5_000;

export interface HostProcessControl {
  readonly argv: readonly string[];
  readonly pid: number;
  on(signal: "SIGTERM" | "SIGINT", listener: () => void): void;
  exit(code: number): void;
}

export interface HostLock {
  release(): void;
}

export interface HostLockResult {
  readonly lock: HostLock;
  readonly outcome: string;
  readonly previousPid?: number;
}

export interface GatewayServerConfig {
  readonly host: string;
  readonly port?: number;
  readonly authToken?: string;
  readonly tls?: unknown;
}

export interface StartedGateway {
  readonly port: number;
  close(): Promise<void>;
}

export interface HostMainHost {
  readonly startedAt: number;
  start(): Promise<void>;
  dispose(): Promise<void>;
  getApi(): unknown;
  subscribe(listener: (event: unknown) => void): () => void;
  getHealth(): unknown;
  noteEventStreamClosed(): void;
  noteDesktopContact(): void;
  prepareForUpgrade(): Promise<unknown>;
  getLocalExecBridge(): unknown;
  getWebAuthnBridge(): unknown;
  reportProcessCrash(error: unknown, kind: string): void;
  reportInvariantViolation(report: unknown): void;
  reportHostDiagnostic(diagnostic: unknown): void;
  reportGatewayCommandError(report: unknown): void;
  reportGatewayCommandSuccess(report: unknown): void;
  flushTelemetryForFatalExit(): Promise<void>;
  reportBoxReady(): Promise<void>;
}

export interface ProcessCrashGuards {
  setReporter(reporter: (error: unknown, kind: string) => void): void;
}

export interface HostMainDependencies {
  executeBoxCopyInFromEnv(): Promise<number>;
  installProcessCrashGuards(options: { scope: "slate-host" }): ProcessCrashGuards;
  installInvariantReporter(reporter: (report: unknown) => void): void;
  pinHostDiagnosticsReporter(reporter: (diagnostic: unknown) => void): void;
  acquireHostLock(): Promise<HostLockResult>;
  startBoxExecDaemon?(): Promise<OwnedBoxExecDaemon>;
  getSlateRootDir(): string;
  createHost(): HostMainHost;
  resolveGatewayServerConfig(): GatewayServerConfig;
  gatewayScheme(config: GatewayServerConfig): string;
  startGatewayServer(options: {
    api: unknown;
    subscribe(listener: (event: unknown) => void): () => void;
    getHealth(): unknown;
    onEventStreamClosed(): void;
    onDesktopContact(): void;
    prepareForUpgrade(): Promise<unknown>;
    startedAt: number;
    host: string;
    port?: number;
    authToken?: string;
    tls?: unknown;
    localExec: unknown;
    webauthn: unknown;
    onCommandError(report: unknown): void;
    onCommandComplete(report: unknown): void;
  }): Promise<StartedGateway>;
  writeGatewayDiscovery(discovery: { port: number; pid: number; startedAt: number; scheme: string; host: string; token?: string }): Promise<void>;
  clearGatewayDiscovery(): Promise<void>;
  readonly log?: Pick<Console, "log" | "error">;
}

/** The box-copy-in bootstrap comes from the box store's own composition, so it is supplied rather than imported here. */
export interface HostProductionPorts extends ProductionSlateHostPorts {
  executeBoxCopyInFromEnv(): Promise<number>;
}

/** The real process graph, wired from the generated ports the packaged entry point has. */
export function createProductionHostMainDependencies(ports: HostProductionPorts): HostMainDependencies {
  const useExistingBoxExecDaemon = process.env.SLATE_USE_EXISTING_BOX_EXEC_DAEMON === "1";
  return {
    executeBoxCopyInFromEnv: ports.executeBoxCopyInFromEnv,
    installProcessCrashGuards: (options) => installProcessCrashGuards(options),
    installInvariantReporter: (reporter) => {
      void installInvariantReporter(reporter);
    },
    pinHostDiagnosticsReporter: (reporter) => pinHostDiagnosticsReporter(reporter as Parameters<typeof pinHostDiagnosticsReporter>[0]),
    acquireHostLock,
    getSlateRootDir,
    createHost: () =>
      createProductionSlateHost({
        ...ports,
        extensionHost: { ...ports.extensionHost, standaloneBoxExecDaemon: !useExistingBoxExecDaemon },
      }),
    resolveGatewayServerConfig,
    gatewayScheme,
    startGatewayServer: (options) => startGatewayServer(options as Parameters<typeof startGatewayServer>[0]),
    writeGatewayDiscovery: (discovery) => writeGatewayDiscovery({ ...discovery, scheme: discovery.scheme as "http" | "https" }),
    clearGatewayDiscovery,
    ...(ports.log === undefined ? {} : { log: ports.log }),
    ...(useExistingBoxExecDaemon
      ? {}
      : {
          startBoxExecDaemon: () =>
            startBoxExecDaemonProcess({
              entryPath: resolveBoxExecDaemonEntry(),
              generated: ports.extensionHost.boxGenerated,
              workspaceRoot: path.join(getSlateRootDir(), "box-workspace"),
              terminalsDirectory: path.join(getSlateRootDir(), "box-terminals"),
              ...(ports.log === undefined ? {} : { log: ports.log }),
            }),
        }),
  };
}

/** Starts the real host graph. */
export function startProductionHost(ports: HostProductionPorts, processControl: HostProcessControl = defaultProcessControl): Promise<void> {
  return main(createProductionHostMainDependencies(ports), processControl);
}

export interface ShutdownRegistration {
  shutdown(signal: "SIGTERM" | "SIGINT"): void;
}

const defaultProcessControl: HostProcessControl = {
  argv: process.argv,
  pid: process.pid,
  on: (signal, listener) => process.on(signal, listener),
  exit: (code) => process.exit(code),
};

/**
 * The process, from the first argument to the last exit code.
 *
 * The copy-in helper is the only mode that does not start a host; it runs, exits with what the copy said, and never
 * touches the lock.
 */
export async function main(deps: HostMainDependencies, processControl: HostProcessControl = defaultProcessControl): Promise<void> {
  const log = deps.log ?? console;

  if (processControl.argv.includes(BOX_COPY_IN_ARG)) {
    let code: number;
    try {
      code = await deps.executeBoxCopyInFromEnv();
    } catch (error) {
      log.error("[box-copy-in] unexpected error (failing closed):", error);
      code = BOX_COPY_IN_EXIT_FAILED;
    }
    processControl.exit(code);
    return;
  }

  const crashGuards = deps.installProcessCrashGuards({ scope: "slate-host" });
  const lockResult = await deps.acquireHostLock();
  reportLockOutcome(lockResult, deps.getSlateRootDir(), log);

  const hostLock = lockResult.lock;
  let boxExecDaemon: OwnedBoxExecDaemon | undefined;
  const host = deps.createHost();
  crashGuards.setReporter((error, kind) => {
    host.reportProcessCrash(error, kind);
  });
  deps.installInvariantReporter((report) => host.reportInvariantViolation(report));
  deps.pinHostDiagnosticsReporter((diagnostic) => {
    host.reportHostDiagnostic(diagnostic);
  });

  try {
    boxExecDaemon = await deps.startBoxExecDaemon?.();
    await host.start();
    const gatewayConfig = deps.resolveGatewayServerConfig();
    const scheme = deps.gatewayScheme(gatewayConfig);
    const gateway = await deps.startGatewayServer({
      api: host.getApi(),
      subscribe: (listener) => host.subscribe(listener),
      getHealth: () => host.getHealth(),
      onEventStreamClosed: () => host.noteEventStreamClosed(),
      onDesktopContact: () => host.noteDesktopContact(),
      prepareForUpgrade: () => host.prepareForUpgrade(),
      startedAt: host.startedAt,
      host: gatewayConfig.host,
      localExec: host.getLocalExecBridge(),
      webauthn: host.getWebAuthnBridge(),
      onCommandError: (report) => host.reportGatewayCommandError(report),
      onCommandComplete: (report) => host.reportGatewayCommandSuccess(report),
      ...(gatewayConfig.port === undefined ? {} : { port: gatewayConfig.port }),
      ...(gatewayConfig.authToken === undefined ? {} : { authToken: gatewayConfig.authToken }),
      ...(gatewayConfig.tls === undefined ? {} : { tls: gatewayConfig.tls }),
    });

    await deps.writeGatewayDiscovery({
      port: gateway.port,
      pid: processControl.pid,
      startedAt: host.startedAt,
      scheme,
      host: gatewayConfig.host,
      ...(gatewayConfig.authToken === undefined ? {} : { token: gatewayConfig.authToken }),
    });

    log.log(
      `[slate-host] gateway listening on ${scheme}://${gatewayConfig.host}:${gateway.port}` + (gatewayConfig.authToken != null ? " (auth required)" : ""),
    );

    installShutdownHandlers(host, gateway, hostLock, deps.clearGatewayDiscovery, processControl, log, SHUTDOWN_WATCHDOG_MS, boxExecDaemon);
    void host.reportBoxReady();
  } catch (error) {
    host.reportProcessCrash(error, "fatal_startup");
    await host.flushTelemetryForFatalExit();
    await boxExecDaemon?.close().catch((closeError) => host.reportProcessCrash(closeError, "box_exec_daemon_startup_cleanup"));
    hostLock.release();
    processControl.exit(1);
  }
}

/** A lock that was taken from a live host, or reclaimed from one that died, is worth one line: it explains the gap. */
export function reportLockOutcome(result: HostLockResult, slateRootDir: string, log: Pick<Console, "log">): void {
  if (result.outcome === "took-over") {
    log.log(`[slate-host] took over ${slateRootDir} from live host pid ${result.previousPid}`);
  } else if (result.previousPid != null) {
    log.log(`[slate-host] reclaimed ${slateRootDir} lock (${result.outcome}) from pid ${result.previousPid}`);
  }
}

/**
 * Shutdown, once.
 *
 * The gateway closes first (so no new command arrives while the host is going away), then the host disposes and the box
 * daemon closes; the discovery file is cleared last, and the lock is released in every path. A shutdown that overruns its
 * watchdog reports itself and exits non-zero — a process that hangs is worse than one that fails.
 */
export function installShutdownHandlers(
  host: Pick<HostMainHost, "dispose" | "reportProcessCrash" | "flushTelemetryForFatalExit">,
  gateway: Pick<StartedGateway, "close">,
  hostLock: HostLock,
  clearGatewayDiscovery: () => Promise<void>,
  processControl: HostProcessControl = defaultProcessControl,
  log: Pick<Console, "log"> = console,
  watchdogMs = SHUTDOWN_WATCHDOG_MS,
  boxExecDaemon?: OwnedBoxExecDaemon,
): ShutdownRegistration {
  let isShuttingDown = false;

  const shutdown = (signal: "SIGTERM" | "SIGINT") => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    log.log(`[slate-host] received ${signal}, shutting down`);

    const watchdog = setTimeout(() => {
      host.reportProcessCrash(null, "shutdown_watchdog");
      void host.flushTelemetryForFatalExit().finally(() => {
        hostLock.release();
        processControl.exit(1);
      });
    }, watchdogMs);
    watchdog.unref();

    void (async () => {
      try {
        await gateway.close();
        await host.dispose();
        await boxExecDaemon?.close();
        await clearGatewayDiscovery();
      } catch (error) {
        host.reportProcessCrash(error, "shutdown_error");
        await host.flushTelemetryForFatalExit();
      } finally {
        clearTimeout(watchdog);
        hostLock.release();
        processControl.exit(0);
      }
    })();
  };

  processControl.on("SIGTERM", () => shutdown("SIGTERM"));
  processControl.on("SIGINT", () => shutdown("SIGINT"));
  return { shutdown };
}
