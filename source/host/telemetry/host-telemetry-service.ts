/**
 * The telemetry a host keeps for itself.
 *
 * One service owns the host's own signals: the structured log, the product analytics, the traces, the event-loop
 * window, the pressure profiler, the desktop-health heartbeat, the box's log shipping and the marker a crashed host
 * leaves. Everything that leaves the machine is gated the same way — no telemetry at all when it was turned off, and
 * nothing but the log when the box's own shipping is off — and everything the service starts is let go in one place
 * when the host ends, with a separate, bounded way to flush what must not be lost when the host is going down hard.
 *
 * Two rules about the console live here: once the service is started, whatever is written to it is also written to the
 * host log (without the forwarding writing itself back), and the console is put back exactly as it was.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { format } from "node:util";
import type { DeadlinePolicy, ExpiryPolicy, PollingPolicy } from "../extensions/scheduling.ts";
import { errorLogTag } from "../../shared/errors/summary.ts";
import { getSlateInferenceBackendUrl } from "../../shared/node/cursor-backend/cursor-inference.ts";
import { getSlateClientVersion } from "../../shared/node/slate-client-metadata.ts";
import { SlateProductAnalytics, type ProductAnalyticsClient, type ProductAnalyticsGate } from "../../shared/node/analytics/product-analytics.ts";
import type { StructuredLogClient } from "../../shared/observability/structured-log-transport.ts";
import { slateMessageLengthBucket } from "../ports/slate-analytics-types.ts";
import { setTurnTraceHostBundleVersion } from "../send-trace-host.ts";
import { withAutomationRunAnalytics, type AnalyticsClient } from "./analytics-service.ts";
import { BoxLogShipper, isBoxLogShippingEnabled } from "./box-log-shipper.ts";
import { forwardDesktopHealthWith } from "./desktop-health-forwarder.ts";
import { createEventLoopTelemetry } from "./event-loop-telemetry.ts";
import { forwardHostCrashMarkerWith, type HostCrashMarkerStore } from "./host-crash-marker.ts";
import { HostLifecycleProgress } from "./host-lifecycle-progress.ts";
import { initSlateHostTracing, type HostTracing } from "./host-tracing.ts";
import { createModelExperimentExposureLatch } from "./model-experiment-exposure.ts";
import { createPressureCpuProfiler } from "./pressure-cpu-profiler.ts";
import { SlateStructuredLogTelemetry, type LogLevel, type Metadata } from "./structured-log-telemetry.ts";

export const SUPERVISOR_LOG_PATH = "/tmp/slate-supervisor.log";
export const SLATE_SUPERVISOR_DESKTOP_HEALTH_PATH = "/tmp/slate-supervisor/desktop-health.json";
export const DESKTOP_HEALTH_FORWARD_INTERVAL_MS = 30_000;
export const DESKTOP_HEALTH_HEARTBEAT_MS = 5 * 60_000;
/** The two gates that decide whether this host reports on its own pressure. */
export const PRESSURE_PROFILER_CONFIG_NAME = "slate_pressure_cpu_profiler_config";
export const PRESSURE_PROFILER_FEATURE_GATE = "slate_enable_pressure_cpu_profiler";

/** What the service asks of whatever ships the box's logs, so a host under test can answer instead of reading files. */
export interface BoxLogShipping {
  start(): Promise<void>;
  stopPolling(): Promise<void>;
  checkpointOffsets(): Promise<void>;
  dispose(): Promise<void>;
}

export type Renewal = {
  outcome: string;
  consecutiveFailures: number;
  durationMs: number;
  errorSummary?: string;
};

export interface ProductAnalytics extends AnalyticsClient {
  activate(experiments: ProductAnalyticsGate): Promise<void>;
  markActive(reason: string): void;
  canRecordEvents(): boolean;
  dispose(): Promise<void>;
}

/** The analytics a host that cannot report anything uses: it answers, and records nothing. */
export class NoopProductAnalytics implements ProductAnalytics {
  async activate(): Promise<void> {}
  markActive(): void {}
  canRecordEvents(): boolean {
    return false;
  }
  trackEvent(): void {}
  async dispose(): Promise<void> {}
}

/** Every credential renewal is reported, including the one that happened before the host was listening. */
export function subscribeToCredentialRenewalTelemetry(
  auth: { subscribeToRenewal(listener: (result: Renewal) => void): () => void; getLastRenewalEvent(): Renewal | null },
  logs: SlateStructuredLogTelemetry,
): () => void {
  const report = (result: Renewal): void =>
    logs.reportInferenceCredentialRenewal(result.outcome === "failed" ? "error" : "info", {
      outcome: result.outcome,
      consecutive_failures: String(result.consecutiveFailures),
      duration_ms: String(result.durationMs),
      error_summary: result.errorSummary,
    });
  const unsubscribe = auth.subscribeToRenewal(report);
  const missed = auth.getLastRenewalEvent();
  if (missed !== null) report(missed);
  return unsubscribe;
}

interface Polling {
  start(listener: () => Promise<void>): { dispose(): void };
}

export interface HostTelemetryOptions {
  auth: {
    peekAccessToken(): string | null;
    getAccessToken(...args: unknown[]): Promise<string>;
    getMachineId(): Promise<string>;
    subscribeToRenewal(listener: (result: Renewal) => void): () => void;
    getLastRenewalEvent(): Renewal | null;
  };
  experiments: {
    checkGate(name: string): Promise<boolean>;
    subscribe(listener: () => void): () => void;
    hasHydratedExperimentUser(): boolean;
    waitForHydratedExperimentUser(ms: number): Promise<boolean>;
    getSlateModelExperimentState(): { active: boolean; arm: string } | null | undefined;
    logSlateModelExperimentExposure(): boolean;
    getDynamicConfig(name: string): Record<string, number> | undefined;
    checkFeatureGate(name: string): boolean;
  };
  inference: { onModelExperimentApplied(listener: () => void): () => void };
  identityTags?: Metadata;
  flushPolling?: PollingPolicy;
  submitDeadline?: DeadlinePolicy;
  identityHoldExpiry?: ExpiryPolicy;
  createStructuredLogClient?: () => StructuredLogClient;
  createProductAnalyticsClient?: () => ProductAnalyticsClient;
  boxLogPolling: Polling;
  desktopHealthPolling: Polling;
  hostCrashMarkerPolling: Polling;
  hostCrashMarkerStore: HostCrashMarkerStore;
  fatalFlushDeadline: { run<T>(operation: () => Promise<T>): Promise<T> };
  clock: { monotonicNow(): number };
  hostLifecycleWatchdog: { arm(listener: () => void): { dispose(): void } };
  /** Where a shared desktop leaves what it reports about itself; the platform's own path unless a host says otherwise. */
  desktopHealthPath?: string;
  createBoxLogShipper?: (
    deps: ConstructorParameters<typeof BoxLogShipper>[0],
  ) => BoxLogShipping;
  analytics?: ProductAnalytics;
  tracing?: HostTracing;
  logs?: SlateStructuredLogTelemetry;
}

export interface MessageSentReport {
  agentId: string;
  prompt?: string;
  attachmentPaths?: readonly string[];
  richText?: string;
  isFork?: boolean;
  source?: string;
  isGroupRoom: boolean;
}

export class HostTelemetryService {
  readonly logs: SlateStructuredLogTelemetry;
  readonly analytics: ProductAnalytics;
  readonly brain: ReturnType<typeof withAutomationRunAnalytics>;
  readonly tracing: HostTracing;
  readonly modelExperimentExposure: ReturnType<typeof createModelExperimentExposureLatch>;
  private eventLoop: ReturnType<typeof createEventLoopTelemetry> | undefined;
  private pressureProfiler: ReturnType<typeof createPressureCpuProfiler> | undefined;
  private boxLogShipper: BoxLogShipping | undefined;
  private desktopHealthPolling: { dispose(): void } | undefined;
  private unsubscribeEvents: (() => void) | undefined;
  private restoreConsole: (() => void) | undefined;
  private hostCrashMarkerForwarding: { dispose(): void } | undefined;
  private lastHandledHostCrashMarker: string | undefined;
  private lastForwardedDesktopHealthRevision: number | null = null;
  private lastForwardedDesktopHealthAtMs: number | null = null;

  constructor(private readonly options: HostTelemetryOptions) {
    this.tracing = options.tracing ?? initSlateHostTracing({
      getToken: options.auth.peekAccessToken.bind(options.auth),
      backendUrl: getSlateInferenceBackendUrl(),
      serviceVersion: getSlateClientVersion(),
    });
    this.logs = options.logs ?? new SlateStructuredLogTelemetry({
      ...(options.identityTags === undefined ? {} : { identityTags: options.identityTags }),
      ...(options.flushPolling === undefined ? {} : { flushPolling: options.flushPolling }),
      ...(options.submitDeadline === undefined ? {} : { submitDeadline: options.submitDeadline }),
      ...(options.identityHoldExpiry === undefined ? {} : { identityHoldExpiry: options.identityHoldExpiry }),
      ...(options.createStructuredLogClient === undefined ? {} : { createClient: options.createStructuredLogClient }),
      getAccessToken: (...args) => options.auth.getAccessToken(...args),
      getMachineId: () => options.auth.getMachineId(),
      // The host's own bundle identity is what the log waits for before it ships anything.
      holdFlushForHostBundleIdentity: true,
    });
    this.analytics = options.analytics ?? new SlateProductAnalytics({
      getAccessToken: (request) => options.auth.getAccessToken(request),
      getMachineId: () => options.auth.getMachineId(),
      ...(options.createProductAnalyticsClient === undefined ? {} : { createClient: options.createProductAnalyticsClient }),
      hostInBox: true,
    });
    this.brain = withAutomationRunAnalytics(this.logs, this.analytics);
    this.modelExperimentExposure = createModelExperimentExposureLatch({ experiments: options.experiments, analytics: this.analytics });
  }

  async start(): Promise<void> {
    this.restoreConsole = this.installConsoleForwarding();
    const unsubscribeRenewal = subscribeToCredentialRenewalTelemetry(this.options.auth, this.logs);
    // The model experiment is noted when the host says it was applied, which is what the exposure latch counts.
    const unsubscribeModelExperiment = this.options.inference.onModelExperimentApplied(() => this.modelExperimentExposure.note());
    this.unsubscribeEvents = () => {
      unsubscribeRenewal();
      unsubscribeModelExperiment();
    };

    const telemetryEnabled = process.env.SLATE_DISABLE_TELEMETRY !== "1";
    if (telemetryEnabled) {
      this.pressureProfiler = createPressureCpuProfiler({ overrides: () => this.options.experiments.getDynamicConfig(PRESSURE_PROFILER_CONFIG_NAME) });
      this.eventLoop = createEventLoopTelemetry({
        report: (summary, trigger) => {
          this.logs.reportHostEventLoop({ trigger, ...summary });
          // Pressure is only profiled when the platform's own gate says a profile may be taken.
          if (trigger === "pressure" && this.options.experiments.checkFeatureGate(PRESSURE_PROFILER_FEATURE_GATE)) this.pressureProfiler?.onPressure();
        },
      });
      // The window and the profiler are fed by the log's own flush, so they cost nothing of their own.
      this.logs.setFlushTickListener(() => {
        this.eventLoop?.onTick();
        this.pressureProfiler?.onTick();
      });
      this.desktopHealthPolling = this.options.desktopHealthPolling.start(() => this.forwardDesktopHealth());
    }
    if (isBoxLogShippingEnabled() && telemetryEnabled) {
      // The supervisor's own log is not shipped: it is where the shipper would write about the shipping.
      const hostLogFile = process.env.SLATE_HOST_LOG_FILE?.trim();
      this.boxLogShipper = (this.options.createBoxLogShipper ??
        ((deps) => new BoxLogShipper(deps)))({
        reportBatch: (records, settle) => this.logs.reportBoxLogBatch(records, settle),
        reportBoxLogShip: (report, settle) => this.logs.reportBoxLogShip(report, settle),
        skipPaths: hostLogFile != null && hostLogFile.length > 0 ? [hostLogFile] : [SUPERVISOR_LOG_PATH],
        polling: this.options.boxLogPolling,
        clock: this.options.clock,
      });
    }
    void this.analytics
      .activate(this.options.experiments)
      .then(() => this.analytics.markActive("host_startup"))
      .catch((error) => {
        // Analytics that could not be activated is a host without analytics, not a host that cannot start.
        console.warn(`[slate-telemetry] analytics activation failed (${errorLogTag(error)})`);
      });
  }

  api() {
    return {
      logs: this.logs,
      brain: this.brain,
      analytics: this.analytics,
      createHostLifecycleProgress: (startedAt: number) =>
        new HostLifecycleProgress({
          startedAt,
          now: () => this.options.clock.monotonicNow(),
          watchdog: this.options.hostLifecycleWatchdog,
          report: (report) => this.logs.reportHostLifecycle(report),
        }),
      setHostBundleIdentity: (identity: { hostBundleVersion?: string; boxStoreId?: string }) => this.setHostBundleIdentity(identity),
      flushTracing: () => this.tracing.flush(),
      flushForFatalExit: () => this.flushForFatalExit(),
      reportMessageSent: (report: MessageSentReport) => this.reportMessageSent(report),
      noteSlateModelExperimentActive: () => this.modelExperimentExposure.note(),
    };
  }

  async setHostBundleIdentity(identity: { hostBundleVersion?: string; boxStoreId?: string }): Promise<void> {
    setTurnTraceHostBundleVersion(identity.hostBundleVersion);
    this.logs.setHostBundleIdentity(identity);
    // The log may only ship once the host knows which bundle it is, so the shipping starts here.
    this.startHostCrashMarkerForwarding();
    await this.boxLogShipper?.start();
  }

  reportMessageSent(report: MessageSentReport): void {
    const text = typeof report.prompt === "string" ? report.prompt.trim() : "";
    const charCount = text.length;
    this.analytics.markActive("user_action");
    this.analytics.trackEvent("slate.message.sent", {
      agent_id: report.agentId,
      char_count: charCount,
      length_bucket: slateMessageLengthBucket(charCount),
      attachment_count: Array.isArray(report.attachmentPaths) ? report.attachmentPaths.length : 0,
      has_rich_text: typeof report.richText === "string" && report.richText.length > 0,
      is_fork: report.isFork === true,
      source: typeof report.source === "string" ? report.source : "desktop",
      is_group_room: report.isGroupRoom === true,
    });
  }

  async dispose(): Promise<void> {
    const shipper = this.boxLogShipper;
    await shipper?.stopPolling();
    await shipper?.checkpointOffsets();
    this.boxLogShipper = undefined;
    this.unsubscribeEvents?.();
    this.unsubscribeEvents = undefined;
    this.hostCrashMarkerForwarding?.dispose();
    this.hostCrashMarkerForwarding = undefined;
    this.desktopHealthPolling?.dispose();
    this.desktopHealthPolling = undefined;
    this.logs.setFlushTickListener(undefined);
    this.eventLoop?.dispose();
    this.eventLoop = undefined;
    this.pressureProfiler?.dispose();
    this.pressureProfiler = undefined;
    this.restoreConsole?.();
    this.restoreConsole = undefined;
    await this.analytics.dispose();
    await this.logs.dispose();
    await shipper?.dispose();
    await this.tracing.dispose();
  }

  /** The marker a crashed host left is forwarded once: the polling stops as soon as there is nothing left to wait for. */
  startHostCrashMarkerForwarding(): void {
    if (this.hostCrashMarkerForwarding !== undefined) return;
    this.hostCrashMarkerForwarding = this.options.hostCrashMarkerPolling.start(async () => {
      const result = await forwardHostCrashMarkerWith({
        store: this.options.hostCrashMarkerStore,
        emit: (marker) => this.logs.reportHostProcessExitConfirmed(marker),
        wasForwarded: (raw) => raw === this.lastHandledHostCrashMarker,
        markForwarded: (raw) => {
          this.lastHandledHostCrashMarker = raw;
        },
      });
      if (result === "absent" || result === "delivered" || result === "parse_error") {
        this.hostCrashMarkerForwarding?.dispose();
        this.hostCrashMarkerForwarding = undefined;
      }
    });
  }

  /** What must be written down even though the host is going down: bounded, and never a reason to fail the exit. */
  async flushForFatalExit(): Promise<void> {
    try {
      await this.options.fatalFlushDeadline.run(async () => {
        const shipper = this.boxLogShipper;
        await shipper?.stopPolling();
        await shipper?.checkpointOffsets();
        await this.logs.dispose();
        await shipper?.dispose();
      });
    } catch {}
  }

  async forwardDesktopHealth(): Promise<void> {
    const path = this.options.desktopHealthPath ?? SLATE_SUPERVISOR_DESKTOP_HEALTH_PATH;
    try {
      await forwardDesktopHealthWith({
        heartbeatMs: DESKTOP_HEALTH_HEARTBEAT_MS,
        readRaw: async () => {
          try {
            if (!existsSync(path)) return null;
            return await readFile(path, "utf8");
          } catch {
            return null;
          }
        },
        emit: (level, metadata) => this.logs.reportDesktopHealth(level, metadata),
        now: Date.now,
        getLast: () => ({ revision: this.lastForwardedDesktopHealthRevision, atMs: this.lastForwardedDesktopHealthAtMs }),
        setLast: (revision, atMs) => {
          this.lastForwardedDesktopHealthRevision = revision;
          this.lastForwardedDesktopHealthAtMs = atMs;
        },
      });
    } catch {}
  }

  /** What is written to the console is also written to the host log — and the console is put back exactly as it was. */
  installConsoleForwarding(): () => void {
    const originalLog = console.log;
    const originalInfo = console.info;
    const originalWarn = console.warn;
    const originalError = console.error;
    let forwarding = false;
    const wrap = (original: (...args: unknown[]) => void, level: LogLevel) => (...args: unknown[]) => {
      original(...args);
      // A log line that is itself written to the console would come back here forever.
      if (forwarding) return;
      forwarding = true;
      try {
        this.logs.reportHostLog(level, format(...args));
      } catch {
      } finally {
        forwarding = false;
      }
    };
    const wrappedLog = wrap(originalLog, "info");
    const wrappedInfo = wrap(originalInfo, "info");
    const wrappedWarn = wrap(originalWarn, "warn");
    const wrappedError = wrap(originalError, "error");
    console.log = wrappedLog;
    console.info = wrappedInfo;
    console.warn = wrappedWarn;
    console.error = wrappedError;
    return () => {
      // Only a console this service wrapped is one it may unwrap.
      if (console.log === wrappedLog) console.log = originalLog;
      if (console.info === wrappedInfo) console.info = originalInfo;
      if (console.warn === wrappedWarn) console.warn = originalWarn;
      if (console.error === wrappedError) console.error = originalError;
    };
  }
}
