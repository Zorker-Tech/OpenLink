import { slateErrorTags, type SlateErrorValue } from "../../shared/errors/registry.ts"
import {
  BOX_BOOT_FAILURE_EVENT,
  BOX_BOOT_STAGE_EVENT,
  BOX_IMAGE_CHECK_EVENT,
  BOX_PROCESS_CRASH_EVENT,
  COOKIE_PERSIST_EVENT,
  DAEMON_PING_EVENT,
  EGRESS_TUNNEL_EVENT,
  EXEC_DAEMON_RESTART_EVENT,
  HOST_BOOT_FETCH_EVENT,
  SUPERVISOR_RESTART_EVENT,
} from "./lifecycle-event-names.ts"

type EventFields = Record<string, string | number | boolean | undefined | { code?: string }>
type EventLevel = "info" | "warn" | "error"
interface TelemetryRecord {
  readonly level: EventLevel
  readonly event: string
  readonly metadata: Record<string, unknown>
}

function record(level: EventLevel, event: string, metadata: Record<string, unknown>): TelemetryRecord {
  return { level, event, metadata }
}

const valueAsText = (value: unknown): string => String(value)

export type BoxImageCheckReport =
  | { trigger: string; outcome: "skipped"; durationMs: number; skipReason: string }
  | { trigger: string; outcome: "answered" | "unanswered"; durationMs: number }
  | { trigger: string; outcome: "timeout" | "failed"; durationMs: number; error: SlateErrorValue }

export function daemonPingTelemetry(report: EventFields): TelemetryRecord {
  const answered = report.outcome === "ok"
  return record(answered ? "warn" : "error", DAEMON_PING_EVENT, {
    outcome: report.outcome,
    attempts: valueAsText(report.attempts),
    duration_ms: valueAsText(report.durationMs),
    unready_duration_ms: valueAsText(report.unreadyDurationMs),
    readiness_state: report.readinessState,
    target: report.target,
    cause: answered ? undefined : report.causeSummary,
  })
}

export function boxImageCheckTelemetry(report: BoxImageCheckReport): TelemetryRecord {
  const isFailure = report.outcome === "timeout" || report.outcome === "failed"
  const tags = isFailure ? slateErrorTags(report.error) : {}
  return record(isFailure ? "warn" : "info", BOX_IMAGE_CHECK_EVENT, {
    trigger: report.trigger,
    outcome: report.outcome,
    duration_ms: valueAsText(report.durationMs),
    skip_reason: report.outcome === "skipped" ? report.skipReason : undefined,
    ...tags,
  })
}

type ProjectEvent = (event: EventFields) => TelemetryRecord

const BOX_EVENT_PROJECTORS: Readonly<Record<string, ProjectEvent>> = {
  boot_stage: (event) => record(event.stage === "ready" ? "warn" : "info", BOX_BOOT_STAGE_EVENT, {
    stage: event.stage,
    duration_ms: valueAsText(event.durationMs),
  }),
  boot_failure: (event) => record("error", BOX_BOOT_FAILURE_EVENT, {
    stage: event.stage,
    reason: event.reason,
    duration_ms: valueAsText(event.durationMs),
  }),
  egress_tunnel: (event) => record(event.outcome === "ready" ? "info" : "warn", EGRESS_TUNNEL_EVENT, {
    outcome: event.outcome,
    attempt: valueAsText(event.attempt),
    exit_status: event.exitStatus === undefined ? undefined : valueAsText(event.exitStatus),
    runtime_s: event.runtimeS === undefined ? undefined : valueAsText(event.runtimeS),
  }),
  host_boot_fetch: (event) => {
    const level: EventLevel = event.outcome === "restore_failed"
      ? "error"
      : event.outcome === "fallback" ? "warn" : "info"
    return record(level, HOST_BOOT_FETCH_EVENT, {
      outcome: event.outcome,
      reason: event.reason,
      duration_ms: valueAsText(event.durationMs),
      swap_ms: event.swapMs === undefined ? undefined : valueAsText(event.swapMs),
      from_version: event.fromVersion,
      to_version: event.toVersion,
    })
  },
  exec_daemon_restart: (event) => record("error", EXEC_DAEMON_RESTART_EVENT, {
    restart_attempt: valueAsText(event.restartAttempt),
    runtime_s: valueAsText(event.runtimeS),
    cause: event.cause,
    exit_status: valueAsText(event.exitStatus),
  }),
  supervisor_restart: (event) => record("error", SUPERVISOR_RESTART_EVENT, {
    restart_attempt: valueAsText(event.restartAttempt),
    runtime_s: valueAsText(event.runtimeS),
    cause: event.cause,
    exit_status: valueAsText(event.exitStatus),
  }),
  cookie_persist: (event) => record(event.outcome === "failed" ? "error" : "warn", COOKIE_PERSIST_EVENT, {
    phase: event.phase,
    outcome: event.outcome,
    seed_cookies: valueAsText(event.seedCookies),
    injected: event.injected === undefined ? undefined : valueAsText(event.injected),
    missing_after: event.missingAfter === undefined ? undefined : valueAsText(event.missingAfter),
    attempts: event.attempts === undefined ? undefined : valueAsText(event.attempts),
  }),
  process_crash: (event) => record("warn", BOX_PROCESS_CRASH_EVENT, {
    binary: event.binary,
    signal: event.signal,
    count: valueAsText(event.count),
  }),
}

export function boxInfrastructureTelemetry(event: EventFields): TelemetryRecord | EventFields {
  const kind = typeof event.kind === "string" ? event.kind : ""
  const project = BOX_EVENT_PROJECTORS[kind]
  return project === undefined ? event : project(event)
}
