/**
 * The codebase-telemetry service: the account it follows, the helper process it keeps, and the snapshots it asks for.
 *
 * There is at most one adapter, and it belongs to the account that is signed in: a new credential (or a lost one)
 * replaces it, closing the old one first, and an adapter that died is restarted after the platform's own delay rather
 * than leaving the host without one. Everything a generation change started is closed rather than adopted, so a slow
 * start can never resurrect an adapter for an account that has already gone.
 */

import { DeadlineExceededError, type DeadlinePolicy, type PollingPolicy, type RetryPolicy } from "../scheduling.ts";
import { CodebaseSnapshotTrigger } from "./codebase-snapshot-trigger.ts";
import { createSlateCodebaseTelemetryHost } from "./codebase-telemetry-host.ts";
import { createCodebaseTelemetryPrivacyMode, type PrivacyMode, type TelemetryAuth } from "./privacy-mode.ts";
import type { CsnapsCodebaseTelemetryAdapter, Logger } from "./codebase-telemetry-adapter.ts";

/** The telemetry's own log line: the level, what happened, and what failed when something did. */
export function createSlateCodebaseTelemetryLogger(log: (message: string) => void): Logger {
  const write = (level: string, message: string, error?: unknown): void =>
    log(`[codebase-telemetry] ${level}: ${message}${error === undefined ? "" : `: ${error instanceof Error ? error.message : String(error)}`}`);
  return {
    error: (message, error) => write("error", message, error),
    warn: (message, error) => write("warn", message, error),
    info: (message, error) => write("info", message, error),
    debug: (message, error) => write("debug", message, error),
  };
}

export interface CodebaseTelemetryServiceOptions {
  readonly auth: Parameters<typeof createSlateCodebaseTelemetryHost>[0]["auth"];
  readonly experiments: Parameters<typeof createSlateCodebaseTelemetryHost>[0]["experiments"];
  readonly events: { on(topic: string, listener: (event: { requestId: string }) => void): () => void };
  readonly createAdapter: (options: { credentials: TelemetryAuth; signal: AbortSignal }) => Promise<CsnapsCodebaseTelemetryAdapter>;
  readonly loadPrivacyMode: (args: { auth: TelemetryAuth; signal: AbortSignal }) => Promise<PrivacyMode>;
  readonly policies: {
    privacyLookupDeadline: DeadlinePolicy;
    privacyLookupRetry: RetryPolicy;
    privacyRefreshPolling: PollingPolicy;
    sessionRestartDelay: RetryPolicy;
    shutdownDeadline: DeadlinePolicy;
  };
  readonly logger: Logger;
}

export function createCodebaseTelemetryService(options: CodebaseTelemetryServiceOptions) {
  const privacyMode = createCodebaseTelemetryPrivacyMode({
    load: options.loadPrivacyMode,
    lookupDeadline: options.policies.privacyLookupDeadline,
    lookupRetry: options.policies.privacyLookupRetry,
    refreshPolling: options.policies.privacyRefreshPolling,
    logger: options.logger,
  });
  let adapter: CsnapsCodebaseTelemetryAdapter | undefined;
  let adapterAbort: AbortController | undefined;
  let restartDelay: { readonly elapsed: Promise<void>; dispose(): void } | undefined;
  let restartPromise: Promise<void> | undefined;
  let stopping = false;
  // Bumped on every start and on shutdown: anything started for an older generation is not adopted.
  let generation = 0;

  const host = createSlateCodebaseTelemetryHost({
    auth: options.auth,
    experiments: options.experiments,
    privacyMode,
    createAdapter: (value) => options.createAdapter(value as { credentials: TelemetryAuth; signal: AbortSignal }),
    logger: options.logger,
  });

  const startAdapter = async (credentials: TelemetryAuth | undefined): Promise<void> => {
    const started = ++generation;
    adapterAbort?.abort();
    adapterAbort = undefined;
    const previous = adapter;
    adapter = undefined;
    await previous?.close();
    if (credentials == null || stopping || started !== generation) return;
    const controller = new AbortController();
    adapterAbort = controller;
    try {
      const created = await options.createAdapter({ credentials, signal: controller.signal });
      // A start that outlived its generation is closed rather than kept.
      if (controller.signal.aborted || stopping || started !== generation) {
        await created.close();
        return;
      }
      adapter = created;
      void created.terminalFailure.then(() => restartAfterFailure(created));
      await created.setDesiredCodebases(host.desiredCodebases.get());
    } catch (error) {
      if (!controller.signal.aborted && !stopping && started === generation) options.logger.error("Failed to start Codebase Telemetry adapter", error);
    }
  };

  /** An adapter that failed is let go first, and a new one is built for the account that is signed in by then. */
  const restartAfterFailure = (failed: CsnapsCodebaseTelemetryAdapter): void => {
    if (stopping || adapter !== failed || restartPromise != null) return;
    restartPromise = (async () => {
      await startAdapter(undefined);
      if (stopping) return;
      const delay = options.policies.sessionRestartDelay.schedule(1);
      restartDelay = delay;
      try {
        await delay.elapsed;
      } catch (error) {
        if (!stopping) throw error;
        return;
      } finally {
        if (restartDelay === delay) restartDelay = undefined;
        delay.dispose();
      }
      if (!stopping) await startAdapter(host.auth.get());
    })().finally(() => {
      restartPromise = undefined;
    });
    void restartPromise.catch((error) => options.logger.error("Failed to restart Codebase Telemetry after adapter failure", error));
  };

  const authSubscription = host.auth.subscribe((credentials) => void startAdapter(credentials));
  void startAdapter(host.auth.get());

  const snapshotTrigger = new CodebaseSnapshotTrigger({ getSession: () => adapter, logger: options.logger });
  const offStart = options.events.on("transcript.run-started", ({ requestId }) => snapshotTrigger.handle({ type: "AGENT_REQUEST_START", requestId }));
  const offEnd = options.events.on("transcript.run-ended", ({ requestId }) => snapshotTrigger.handle({ type: "AGENT_REQUEST_END", requestId }));

  let disposePromise: Promise<void> | undefined;
  return {
    api: {
      async flushPendingUploads(): Promise<void> {
        if (adapter != null) await adapter.flushPendingUploads();
      },
    },
    dispose(): Promise<void> {
      stopping = true;
      generation += 1;
      adapterAbort?.abort();
      restartDelay?.dispose();
      return (disposePromise ??= (async () => {
        authSubscription.dispose();
        offStart();
        offEnd();
        try {
          await options.policies.shutdownDeadline.run(async () => {
            await adapter?.close();
          });
        } catch (error) {
          // A shutdown that ran out of time is the shutdown deadline's business, not the caller's.
          if (!(error instanceof DeadlineExceededError)) throw error;
          options.logger.warn("Controller shutdown exceeded its deadline", error);
        } finally {
          adapter = undefined;
          host.dispose();
          privacyMode.dispose();
        }
      })());
    },
  };
}
