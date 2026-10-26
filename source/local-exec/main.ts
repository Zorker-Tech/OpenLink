/**
 * The local-exec daemon's own process.
 *
 * It starts by establishing its identity and its connection, answers the host's calls, and drains what is in flight when
 * it is asked to stop — writing down what it was doing if it finds one of its own invariants broken.
 */
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

import { createDeadlinePolicy, realClock, type DeadlinePolicy } from "../host/extensions/scheduling.ts";
import { LOCAL_EXEC_GENERATION_TOKEN_ARG, LOCAL_EXEC_GENERATION_TOKEN_ENV } from "../shared/local-exec-process-identity.ts";
import { runLocalExecDaemon, type RunLocalExecDaemonOptions } from "../host/local-exec/local-exec-daemon.ts";
import { installProcessCrashGuards, type ProcessCrashKind } from "../host/process-crash-guard.ts";
import { flushSlateSentry, initSlateSentryDaemon, type SlateSentryDaemonRuntime } from "../host/local-exec/sentry.ts";
import { installInvariantReporter } from "../shared/invariant.ts";
import { writeInvariantViolationLog } from "./invariant-violation-log.ts";
import {
  createDefaultProductionLocalExecExecutor,
  type ProductionLocalExecExecutorFactory,
} from "./production-executor.ts";

export const LOCAL_EXEC_DAEMON_SHUTDOWN_TIMEOUT_MS = 2_000;
export const LOCAL_EXEC_DAEMON_LIFETIME_TICK_MS = 60_000;

type DaemonSignal = "SIGTERM" | "SIGINT";
type ClosableDaemon = { close(): Promise<void> };
type DaemonCrashReporter = (error: Error, kind: ProcessCrashKind | "fatal") => void;

export interface LocalExecDaemonLifetime {
  release(): void;
}

/**
 * Node promises and the shared scheduling policies do not keep a process alive:
 * the latter intentionally unref their timers. The standalone daemon therefore
 * owns one referenced handle until its signal-driven shutdown has closed the
 * provider and cleared discovery.
 */
export function holdLocalExecDaemonProcessOpen(
  setIntervalImpl: typeof setInterval = setInterval,
  clearIntervalImpl: typeof clearInterval = clearInterval,
): LocalExecDaemonLifetime {
  const keepalive = setIntervalImpl(() => {}, LOCAL_EXEC_DAEMON_LIFETIME_TICK_MS);
  keepalive.ref?.();

  let active = true;
  return {
    release() {
      if (!active) return;
      active = false;
      clearIntervalImpl(keepalive);
    },
  };
}

export interface LocalExecDaemonMainDeps {
  readonly runDaemon: (options?: RunLocalExecDaemonOptions) => Promise<ClosableDaemon>;
  readonly daemonOptions?: RunLocalExecDaemonOptions;
  readonly initCrashReporter?: () => DaemonCrashReporter | undefined;
  readonly flushCrashReporter?: (timeoutMs: number) => Promise<boolean>;
  readonly process?: Pick<NodeJS.Process, "pid" | "on" | "exit">;
  readonly log?: (message: string) => void;
  readonly holdProcessOpen?: () => LocalExecDaemonLifetime;
  /** Injectable seams keep lifecycle behavior tests away from global process state and real timers. */
  readonly shutdownDeadline?: DeadlinePolicy;
  readonly installInvariantReporter?: typeof installInvariantReporter;
  readonly installCrashGuards?: typeof installProcessCrashGuards;
}

interface ShutdownControl {
  request(signal: DaemonSignal): void;
  ready(daemon: ClosableDaemon): void;
}

/** Owns the state transitions from an early signal through a single daemon drain. */
function createShutdownControl(
  processLike: Pick<NodeJS.Process, "pid" | "exit">,
  log: (message: string) => void,
  lifetime: LocalExecDaemonLifetime,
  deadline: DeadlinePolicy,
): ShutdownControl {
  let runningDaemon: ClosableDaemon | undefined;
  let queuedSignal: DaemonSignal | undefined;
  let drainStarted = false;

  const request = (signal: DaemonSignal): void => {
    if (drainStarted) return;

    if (runningDaemon === undefined) {
      queuedSignal ??= signal;
      log(`[slate-local-exec-daemon] received ${signal} during startup; shutdown queued`);
      return;
    }

    drainStarted = true;
    const daemonBeingDrained = runningDaemon;
    log(`[slate-local-exec-daemon] received ${signal}, shutting down`);
    void deadline.run(() => daemonBeingDrained.close()).finally(() => {
      lifetime.release();
      processLike.exit(0);
    });
  };

  return {
    request,
    ready(daemon) {
      runningDaemon = daemon;
      if (queuedSignal !== undefined) {
        request(queuedSignal);
        return;
      }
      log(`[slate-local-exec-daemon] started (pid ${processLike.pid}); serving local exec over the gateway`);
    },
  };
}

function installDaemonSignalHandlers(
  processLike: Pick<NodeJS.Process, "on">,
  control: ShutdownControl,
): void {
  processLike.on("SIGTERM", () => control.request("SIGTERM"));
  processLike.on("SIGINT", () => control.request("SIGINT"));
}

function installDaemonCrashReporting(deps: LocalExecDaemonMainDeps): void {
  const installInvariant = deps.installInvariantReporter ?? installInvariantReporter;
  const installGuards = deps.installCrashGuards ?? installProcessCrashGuards;
  installInvariant((report) => writeInvariantViolationLog(report));

  const guards = installGuards({ scope: "slate-local-exec-daemon" });
  const reporter = deps.initCrashReporter?.();
  if (reporter !== undefined) guards.setReporter(reporter);
}

function shutdownDeadlineFor(deps: LocalExecDaemonMainDeps): DeadlinePolicy {
  return deps.shutdownDeadline ?? createDeadlinePolicy(realClock, {
    name: "local-exec-daemon-shutdown",
    timeoutMs: LOCAL_EXEC_DAEMON_SHUTDOWN_TIMEOUT_MS,
  });
}

export async function runLocalExecDaemonMain(
  deps: LocalExecDaemonMainDeps,
): Promise<{ shutdown(signal: DaemonSignal): void }> {
  const processLike = deps.process ?? process;
  const log = deps.log ?? console.log;
  installDaemonCrashReporting(deps);

  const keepalive = (deps.holdProcessOpen ?? holdLocalExecDaemonProcessOpen)();
  const shutdown = createShutdownControl(processLike, log, keepalive, shutdownDeadlineFor(deps));
  installDaemonSignalHandlers(processLike, shutdown);

  let daemon: ClosableDaemon;
  try {
    daemon = await deps.runDaemon(deps.daemonOptions);
  } catch (error) {
    keepalive.release();
    throw error;
  }

  shutdown.ready(daemon);
  return { shutdown: shutdown.request };
}

function asFatalError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

async function sendFatalReport(
  deadline: DeadlinePolicy,
  reportCrash: DaemonCrashReporter | undefined,
  flushCrashReporter: ((timeoutMs: number) => Promise<boolean>) | undefined,
  error: unknown,
): Promise<void> {
  await deadline.run(async () => {
    reportCrash?.(asFatalError(error), "fatal");
    await flushCrashReporter?.(1_500);
  });
}

export async function reportLocalExecDaemonFatal(
  deps: Pick<LocalExecDaemonMainDeps, "initCrashReporter" | "flushCrashReporter" | "process">,
  error: unknown,
): Promise<never> {
  const processLike = deps.process ?? process;
  const deadline = createDeadlinePolicy(realClock, {
    name: "local-exec-daemon-shutdown",
    timeoutMs: LOCAL_EXEC_DAEMON_SHUTDOWN_TIMEOUT_MS,
  });
  const reporter = deps.initCrashReporter?.();
  await sendFatalReport(deadline, reporter, deps.flushCrashReporter, error).catch(() => {});
  processLike.exit(1);
  throw new Error("process.exit returned unexpectedly");
}

function isUsableSentryRuntime(runtime: Partial<SlateSentryDaemonRuntime>): boolean {
  return runtime.init != null
    && runtime.captureException != null
    && runtime.flush != null
    && runtime.makeNodeTransport != null;
}

export function loadLocalExecSentryRuntime(
  requireModule: (id: string) => unknown = createRequire(import.meta.url),
): SlateSentryDaemonRuntime | undefined {
  try {
    const runtime = requireModule("@sentry/node") as Partial<SlateSentryDaemonRuntime>;
    return isUsableSentryRuntime(runtime) ? runtime as SlateSentryDaemonRuntime : undefined;
  } catch {
    return undefined;
  }
}

function alreadyHasExecutor(options: RunLocalExecDaemonOptions | undefined): boolean {
  return options?.executor !== undefined;
}

export function composeLocalExecDaemonOptions(
  daemonOptions: RunLocalExecDaemonOptions | undefined,
  productionExecutorFactory: ProductionLocalExecExecutorFactory | undefined,
): RunLocalExecDaemonOptions | undefined {
  if (alreadyHasExecutor(daemonOptions) || productionExecutorFactory === undefined) return daemonOptions;
  return { ...daemonOptions, executor: productionExecutorFactory() };
}

function reporterInitializer(sentryRuntime: SlateSentryDaemonRuntime | undefined): () => DaemonCrashReporter | undefined {
  let initialized = false;
  let reporter: DaemonCrashReporter | undefined;

  return () => {
    if (initialized) return reporter;
    initialized = true;
    reporter = sentryRuntime === undefined ? undefined : initSlateSentryDaemon(sentryRuntime);
    return reporter;
  };
}

function generationFromArguments(arguments_: readonly string[]): string | undefined {
  const tokenArgument = arguments_.find((argument) => argument.startsWith(LOCAL_EXEC_GENERATION_TOKEN_ARG));
  return tokenArgument?.slice(LOCAL_EXEC_GENERATION_TOKEN_ARG.length);
}

function bindGenerationToDaemonEntry(
  daemonOptions: RunLocalExecDaemonOptions | undefined,
  invokedEntry: string | undefined,
  environmentToken: string | undefined,
  argumentToken: string | undefined,
): RunLocalExecDaemonOptions {
  if (invokedEntry === undefined || environmentToken === undefined || environmentToken.length === 0 || argumentToken !== environmentToken) {
    throw new Error("local-exec daemon entry identity is not bound");
  }
  return {
    ...(daemonOptions ?? {}),
    entryRealpath: realpathSync(invokedEntry),
    generationToken: environmentToken,
  };
}

function fatalDependencies(
  initCrashReporter: () => DaemonCrashReporter | undefined,
  processLike: Pick<NodeJS.Process, "pid" | "on" | "exit"> | undefined,
): Pick<LocalExecDaemonMainDeps, "initCrashReporter" | "flushCrashReporter" | "process"> {
  return {
    initCrashReporter,
    flushCrashReporter: flushSlateSentry,
    ...(processLike === undefined ? {} : { process: processLike }),
  };
}

export async function runLocalExecDaemonEntrypoint(options: {
  readonly daemonOptions?: RunLocalExecDaemonOptions;
  readonly productionExecutorFactory?: ProductionLocalExecExecutorFactory;
  readonly sentryRuntime?: SlateSentryDaemonRuntime;
  readonly process?: Pick<NodeJS.Process, "pid" | "on" | "exit">;
} = {}): Promise<void> {
  const sentryRuntime = options.sentryRuntime ?? loadLocalExecSentryRuntime();
  const initCrashReporter = reporterInitializer(sentryRuntime);

  try {
    const daemonOptions = composeLocalExecDaemonOptions(
      options.daemonOptions,
      options.productionExecutorFactory ?? createDefaultProductionLocalExecExecutor,
    );
    const boundOptions = bindGenerationToDaemonEntry(
      daemonOptions,
      process.argv[1],
      process.env[LOCAL_EXEC_GENERATION_TOKEN_ENV],
      generationFromArguments(process.argv),
    );

    await runLocalExecDaemonMain({
      runDaemon: runLocalExecDaemon,
      daemonOptions: boundOptions,
      initCrashReporter,
      flushCrashReporter: flushSlateSentry,
      ...(options.process === undefined ? {} : { process: options.process }),
    });
  } catch (error) {
    await reportLocalExecDaemonFatal(
      fatalDependencies(initCrashReporter, options.process),
      error,
    );
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  void runLocalExecDaemonEntrypoint();
}
