/** Provider-specific crash reporting for the local-exec daemon, behind the shared privacy gate. */
import { createRequire } from "node:module";
import type { ProcessCrashKind } from "../../../host/process-crash-guard.ts";
import { SLATE_SENTRY_DSN, SlateSentryPrivacyGate, gateEnvelopeSend, type SlateSentryEnvelope } from "../../../shared/observability/sentry.ts";

interface CrashReportTransport { send(envelope: SlateSentryEnvelope): Promise<unknown>; readonly [key: string]: unknown; }
export interface DaemonCrashReporterRuntime {
  init(options: Record<string, unknown>): void;
  eventFiltersIntegration(): unknown; functionToStringIntegration(): unknown; linkedErrorsIntegration(): unknown; dedupeIntegration(): unknown;
  makeNodeTransport(options: unknown): CrashReportTransport;
  setTag(key: string, value: string): void;
  captureException(error: Error, options: { readonly level: "fatal"; readonly tags: { readonly "crash.kind": ProcessCrashKind | "fatal" } }): void;
  flush(timeoutMs: number): Promise<boolean>;
}

function supportsCrashReporting(runtime: Partial<DaemonCrashReporterRuntime>): boolean {
  return runtime.init != null
    && runtime.captureException != null
    && runtime.flush != null
    && runtime.makeNodeTransport != null;
}

export function loadDaemonCrashReporterRuntime(
  requireModule: (id: string) => unknown = createRequire(import.meta.url),
): DaemonCrashReporterRuntime | undefined {
  try {
    const runtime = requireModule("@sentry/node") as Partial<DaemonCrashReporterRuntime>;
    return supportsCrashReporting(runtime) ? runtime as DaemonCrashReporterRuntime : undefined;
  } catch {
    return undefined;
  }
}

let activeRuntime: DaemonCrashReporterRuntime | undefined;
export function initializeDaemonCrashReporter(runtime: DaemonCrashReporterRuntime, env: NodeJS.ProcessEnv = process.env): ((error: Error, kind: ProcessCrashKind | "fatal") => void) | undefined {
  const environment = env.SLATE_SENTRY_ENVIRONMENT; const release = env.SLATE_SENTRY_RELEASE; if (environment === undefined || release === undefined) return undefined;
  try { const gate = new SlateSentryPrivacyGate(); runtime.init({ dsn: SLATE_SENTRY_DSN, environment, release, includeServerName: false, defaultIntegrations: false, skipOpenTelemetrySetup: true, integrations: [runtime.eventFiltersIntegration(), runtime.functionToStringIntegration(), runtime.linkedErrorsIntegration(), runtime.dedupeIntegration()], transport: (transportOptions: unknown) => { const base = runtime.makeNodeTransport(transportOptions); return { ...base, send: gateEnvelopeSend(gate, (envelope) => base.send(envelope)) }; } }); runtime.setTag("slate.process", "local-exec-daemon"); activeRuntime = runtime; return (error, kind) => { void runtime.captureException(error, { level: "fatal", tags: { "crash.kind": kind } }); }; }
  catch (error) { console.error("[slate-local-exec-daemon] Sentry init failed:", error); return undefined; }
}
export function flushDaemonCrashReporter(timeoutMs: number): Promise<boolean> { return activeRuntime?.flush(timeoutMs) ?? Promise.resolve(true); }
