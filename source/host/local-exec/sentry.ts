/** The local-exec daemon's own crash reporting: reports are scrubbed like any other before they are sent. */
import type { ProcessCrashKind } from "../process-crash-guard.ts";
import { SLATE_SENTRY_DSN, SlateSentryPrivacyGate, gateEnvelopeSend, type SlateSentryEnvelope } from "../../shared/observability/sentry.ts";

interface SentryTransport { send(envelope: SlateSentryEnvelope): Promise<unknown>; readonly [key: string]: unknown; }
export interface SlateSentryDaemonRuntime {
  init(options: Record<string, unknown>): void;
  eventFiltersIntegration(): unknown; functionToStringIntegration(): unknown; linkedErrorsIntegration(): unknown; dedupeIntegration(): unknown;
  makeNodeTransport(options: unknown): SentryTransport;
  setTag(key: string, value: string): void;
  captureException(error: Error, options: { readonly level: "fatal"; readonly tags: { readonly "crash.kind": ProcessCrashKind | "fatal" } }): void;
  flush(timeoutMs: number): Promise<boolean>;
}

let activeRuntime: SlateSentryDaemonRuntime | undefined;
export function initSlateSentryDaemon(runtime: SlateSentryDaemonRuntime, env: NodeJS.ProcessEnv = process.env): ((error: Error, kind: ProcessCrashKind | "fatal") => void) | undefined {
  const environment = env.SLATE_SENTRY_ENVIRONMENT; const release = env.SLATE_SENTRY_RELEASE; if (environment === undefined || release === undefined) return undefined;
  try { const gate = new SlateSentryPrivacyGate(); runtime.init({ dsn: SLATE_SENTRY_DSN, environment, release, includeServerName: false, defaultIntegrations: false, skipOpenTelemetrySetup: true, integrations: [runtime.eventFiltersIntegration(), runtime.functionToStringIntegration(), runtime.linkedErrorsIntegration(), runtime.dedupeIntegration()], transport: (transportOptions: unknown) => { const base = runtime.makeNodeTransport(transportOptions); return { ...base, send: gateEnvelopeSend(gate, (envelope) => base.send(envelope)) }; } }); runtime.setTag("slate.process", "local-exec-daemon"); activeRuntime = runtime; return (error, kind) => { void runtime.captureException(error, { level: "fatal", tags: { "crash.kind": kind } }); }; }
  catch (error) { console.error("[slate-local-exec-daemon] Sentry init failed:", error); return undefined; }
}
export function flushSlateSentry(timeoutMs: number): Promise<boolean> { return activeRuntime?.flush(timeoutMs) ?? Promise.resolve(true); }
