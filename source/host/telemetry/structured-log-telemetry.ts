/**
 * The structured log the host writes: the one place that turns what happened into the platform's own events.
 *
 * A report either comes from a mapper — the modules that each know one family of events — or is built here from the
 * fields the caller has. Everything goes through one enqueue, which is where the two rules live: a value the caller
 * did not have never reaches the log, and one they did goes as text.
 *
 * The transport is the real one when the host has everything it takes to build it, and an in-memory one otherwise, so
 * a host that cannot ship logs still answers every report. A turn's own lifecycle is kept here too: the start it
 * emits once it knows its model, the retries it counts, and the outcome it reports exactly once.
 */

import { AnalyticsService } from "../../packages/proto/generated/aiserver/v1/analytics_connect.ts";
import { slateErrorTags, slateErrorWireCode, type SlateErrorValue } from "../../shared/errors/registry.ts";
import { getSlateClientVersion, SLATE_CLIENT_TYPE } from "../../shared/node/slate-client-metadata.ts";
import { createSlateCursorBackendClient } from "../../shared/node/cursor-backend/cursor-inference.ts";
import { connectorAuthTelemetry, type ConnectorAuthReport } from "../../shared/observability/connector-auth-telemetry.ts";
import { StructuredLogTransport, type StructuredLogClient } from "../../shared/observability/structured-log-transport.ts";
import {
  AGENT_ERROR_DETAIL_EVENT,
  AGENT_ERROR_EVENT,
  AGENT_OPEN_EVENT,
  AUTOMATION_LIFECYCLE_EVENT,
  AUTO_REVIEW_DISPLAY_RECHECK_FAILED_EVENT,
  AUTO_REVIEW_EXPIRE_SWEEP_FAILED_EVENT,
  BOT_BLOCK_DETAIL_EVENT,
  BOT_BLOCK_EVENT,
  BOX_COPY_IN_EVENT,
  BOX_HELP_EVENT,
  BOX_LOG_EVENT,
  BOX_RECREATE_DECIDED_EVENT,
  BOX_STORE_DB_CAPTURE_EVENT,
  BOX_STORE_MANIFEST_CONFLICT_EVENT,
  BOX_STORE_SYNC_EVENT,
  CHROME_SESSION_STAGE_EVENT,
  CLIENT_RESOURCE_EVENT,
  CONNECTOR_AUTH_EVENT,
  DESKTOP_HEALTH_EVENT,
  GATEWAY_COMMAND_ERROR_EVENT,
  GATEWAY_COMMAND_TIMING_EVENT,
  HOST_CRASH_EVENT,
  HOST_INVARIANT_VIOLATION_EVENT,
  HOST_LOG_EVENT,
  HOST_UPGRADE_EVENT,
  INFERENCE_CREDENTIAL_RENEWAL_EVENT,
  MCP_AUTH_CLEANUP_EVENT,
  MCP_DISCOVERY_FAILED_EVENT,
  PLUGIN_SKILLS_SYNC_EVENT,
  SKILL_PUBLISH_EDGE_FAILED_EVENT,
  SLATE_LOG_KEY,
  TEACH_RECORDING_CAP_STOP_FAILED_EVENT,
  TEACH_RECORDING_START_FAILED_EVENT,
  TOOL_CALL_ERROR_EVENT,
  TOOL_CALL_STALLED_EVENT,
  TOOL_CALL_STARTED_EVENT,
  TURN_OUTCOME_DETAIL_EVENT,
  TURN_OUTCOME_EVENT,
  TURN_START_EVENT,
} from "../../shared/observability/telemetry-events.ts";
import type { DeadlinePolicy, ExpiryPolicy, PollingPolicy } from "../extensions/scheduling.ts";
import { resolveBoxIdentityTags } from "../ports/telemetry.ts";
import { hostCrashMarkerMetadata, type HostCrashMarker } from "./host-crash-marker.ts";
import { autoReviewApprovalTelemetry } from "./auto-review-approval-telemetry.ts";
import { automationFireDroppedTelemetry, automationRunTelemetry } from "./automation-fire-telemetry.ts";
import { automationShadowPruneTelemetry } from "./automation-shadow-prune-telemetry.ts";
import { boxLogShipTelemetry } from "./box-log-ship-telemetry.ts";
import { conversationGcTelemetry } from "./conversation-gc-telemetry.ts";
import { diskPressureReport } from "./disk-pressure-telemetry.ts";
import { eventLoopWindowTelemetry } from "./event-loop-telemetry.ts";
import { experimentsDiagnosticTelemetry } from "./experiments-diagnostic-telemetry.ts";
import { hostDiagnosticTelemetry } from "./host-diagnostic-telemetry.ts";
import { hostEventBusTelemetry } from "./host-event-bus-telemetry.ts";
import { hostExtensionDiagnosticTelemetry } from "./host-extension-diagnostic-telemetry.ts";
import { boxImageCheckTelemetry, boxInfrastructureTelemetry, daemonPingTelemetry, hostLifecycleTelemetry, hostStartupTelemetry } from "./lifecycle-telemetry.ts";
import { localExecFailedTelemetry, localExecProviderTelemetry, localExecRefusedTelemetry } from "./local-exec-telemetry.ts";
import { memorySynthesisTelemetry } from "./memory-synthesis-telemetry.ts";
import { ackObligationTelemetry, pendingWakeTelemetry, queueAcceptedTelemetry, queueDequeuedTelemetry, queueWatchdogTelemetry, sendDispatchTelemetry } from "./queue-telemetry-mappers.ts";
import { shellRevivalTelemetry, subagentRevivalTelemetry } from "./revival-telemetry-mappers.ts";
import { searchIndexHealthTelemetry } from "./search-index-health-telemetry.ts";
import { sessionDiagnosticTelemetry } from "./session-diagnostic-telemetry.ts";
import { turnEmptyDeliveryTelemetry } from "./turn-empty-delivery-telemetry.ts";
import { closingSendNudgeTelemetry, computerUseUsageTelemetry, ttftTelemetry, turnAwaitTelemetry, turnInterruptTelemetry, turnRetryTelemetry, turnUsageTelemetry, userMessageReceivedTelemetry } from "./turn-telemetry-mappers.ts";
import { webauthnProxyTelemetry } from "./webauthn-proxy-telemetry.ts";
import { journalOutcomeTelemetry } from "./journal-outcome-telemetry.ts";

export type LogLevel = "info" | "warn" | "error";
export type Metadata = Record<string, string | undefined>;

/** What the telemetry writes through, as the rest of this file needs it. */
export interface StructuredLogTransportLike {
  enqueue(level: LogLevel, message: string, metadata: Metadata, onSettled?: (settlement: "delivered" | "dropped") => void): void;
  shipConfirmed(level: LogLevel, message: string, metadata: Metadata): Promise<boolean>;
  setIdentityTags(tags: Metadata): void;
  setFlushTickListener(listener?: () => void): void;
  dispose(): Promise<unknown>;
}

/** The transport a host that cannot ship logs keeps its records in — readable, and never lost. */
export class InMemoryStructuredLogTransport implements StructuredLogTransportLike {
  readonly entries: Array<{ level: LogLevel; message: string; metadata: Metadata }> = [];
  identityTags: Metadata = {};
  private flushTickListener: (() => void) | undefined;

  enqueue(level: LogLevel, message: string, metadata: Metadata, onSettled?: (settlement: "delivered" | "dropped") => void): void {
    this.entries.push({ level, message, metadata: { ...this.identityTags, ...metadata } });
    onSettled?.("delivered");
  }

  async shipConfirmed(level: LogLevel, message: string, metadata: Metadata): Promise<boolean> {
    this.enqueue(level, message, metadata);
    return true;
  }

  /** An identity tag with nothing in it is not an identity tag. */
  setIdentityTags(tags: Metadata): void {
    const known: Metadata = {};
    for (const [key, value] of Object.entries(tags)) {
      if (value !== undefined && value.length > 0) known[key] = value;
    }
    this.identityTags = known;
  }

  setFlushTickListener(listener?: () => void): void {
    this.flushTickListener = listener;
  }

  /** The in-memory transport has no schedule of its own; a test asks it to flush instead. */
  tick(): void {
    this.flushTickListener?.();
  }

  async dispose(): Promise<void> {}
}

export const TELEMETRY_FLUSH_TICK_MS = 3_000;
export const HOST_IDENTITY_HOLD_BACKSTOP_MS = 90_000;
export const MAX_HOST_LOG_LENGTH = 2_048;
export const MAX_ERROR_DETAIL_MESSAGE_LENGTH = 1_024;
export const MAX_ERROR_DETAIL_STACK_LENGTH = 4_096;
export const TOOL_CALL_MS_CAP = 24 * 60 * 60 * 1_000;

/** When this build was made; the release stamps it. */
export const HOST_BUILT_AT_MS = "1786556440000";

export function getHostBuiltAtMs(): string {
  return HOST_BUILT_AT_MS;
}

export function truncateStructuredLogValue(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

/** A tool call's duration, as the log takes it: whole, never negative, never longer than a day. */
export function cappedToolCallMs(ms: number): string {
  return String(Math.min(Math.max(0, Math.round(ms)), TOOL_CALL_MS_CAP));
}

export function structuredErrorCode(error: unknown): string {
  return slateErrorWireCode(typeof error === "object" && error !== null ? error : {});
}

export function errorDetailTags(error: unknown, detail: { message: string; stack?: string }) {
  return {
    error_code: structuredErrorCode(error),
    error_message: truncateStructuredLogValue(detail.message, MAX_ERROR_DETAIL_MESSAGE_LENGTH),
    error_stack: detail.stack !== undefined ? truncateStructuredLogValue(detail.stack, MAX_ERROR_DETAIL_STACK_LENGTH) : undefined,
  };
}

type Fields = Record<string, unknown>;

/** What a mapper answers with: the level it decided, what it is called, and what goes with it. */
type MapperResult = { level: string; event?: string; message?: string; metadata: Record<string, unknown> };

/** A value the caller had, as text; a value they did not have is not written at all. */
function asText(value: unknown): string | undefined {
  return value === undefined ? undefined : String(value);
}

/** The same, for the fields the platform sends as a number, a flag or nothing. */
function asPresentText(value: unknown): string | undefined {
  return value == null ? undefined : String(value);
}

export interface SlateStructuredLogTelemetryOptions {
  readonly transport?: StructuredLogTransportLike;
  readonly identityTags?: Metadata;
  readonly appVersion?: string;
  readonly getAccessToken?: (request: unknown) => Promise<string>;
  readonly getMachineId?: () => Promise<string>;
  readonly createClient?: () => StructuredLogClient;
  readonly flushPolling?: PollingPolicy;
  readonly submitDeadline?: DeadlinePolicy;
  readonly identityHoldExpiry?: ExpiryPolicy;
  readonly holdFlushForHostBundleIdentity?: boolean;
}

/** Whether the host has everything the shipping transport needs — a client, and the policies that pace it. */
function canShipLogs(options: SlateStructuredLogTelemetryOptions): options is SlateStructuredLogTelemetryOptions & { flushPolling: PollingPolicy; submitDeadline: DeadlinePolicy } {
  const hasClient = options.createClient !== undefined || (options.getAccessToken !== undefined && options.getMachineId !== undefined);
  const hasPacing = options.flushPolling !== undefined && options.submitDeadline !== undefined;
  const hasHold = options.holdFlushForHostBundleIdentity !== true || options.identityHoldExpiry !== undefined;
  return hasClient && hasPacing && hasHold;
}

export class SlateStructuredLogTelemetry {
  readonly transport: StructuredLogTransportLike;
  readonly activeTurnsByConversation = new Map<string, SlateTurnTelemetryImpl>();

  constructor(options: SlateStructuredLogTelemetryOptions) {
    if (options.transport !== undefined) {
      this.transport = options.transport;
      if (options.identityTags !== undefined) this.transport.setIdentityTags(options.identityTags);
      return;
    }
    this.transport = canShipLogs(options) ? this.shippingTransport(options) : new InMemoryStructuredLogTransport();
    if (!canShipLogs(options) && options.identityTags !== undefined) this.transport.setIdentityTags(options.identityTags);
  }

  private shippingTransport(options: SlateStructuredLogTelemetryOptions & { flushPolling: PollingPolicy; submitDeadline: DeadlinePolicy }): StructuredLogTransportLike {
    const platformTags: Metadata = {
      client: SLATE_CLIENT_TYPE,
      "client.type": SLATE_CLIENT_TYPE,
      client_version: getSlateClientVersion(),
      app_version: options.appVersion ?? "0.18.0",
      arch: process.arch,
      platform: process.platform,
      ...(options.identityTags ?? resolveBoxIdentityTags()),
    };
    const createClient = options.createClient ?? (() =>
      createSlateCursorBackendClient(AnalyticsService, {
        // A credential that cannot be had is not a reason to drop a log line: the request goes out unauthenticated.
        getAccessToken: async (request) => {
          try {
            return await options.getAccessToken!(request);
          } catch {
            return "";
          }
        },
        getMachineId: options.getMachineId!,
      }) as unknown as StructuredLogClient);
    return new StructuredLogTransport({
      key: SLATE_LOG_KEY,
      platformTags,
      createClient,
      polling: options.flushPolling,
      submitDeadline: options.submitDeadline,
      holdForIdentity: options.holdFlushForHostBundleIdentity === true,
      disabled: process.env.SLATE_DISABLE_TELEMETRY === "1",
      ...(options.identityHoldExpiry === undefined ? {} : { identityHoldExpiry: options.identityHoldExpiry }),
    });
  }

  /** Which build this host is, and which store it keeps, said once the bundle knows. */
  setHostBundleIdentity(identity: { hostBundleVersion?: string; boxStoreId?: string }): void {
    this.transport.setIdentityTags({
      host_bundle_version: identity.hostBundleVersion,
      host_built_at_ms: getHostBuiltAtMs(),
      box_store_id: identity.boxStoreId,
    });
  }

  startTurn(start: { conversationId: string; turnType: string; model?: string }): SlateTurnTelemetryImpl {
    const turn = new SlateTurnTelemetryImpl(this, start, () => {
      // Only the turn that is still the current one takes itself out of the map.
      if (this.activeTurnsByConversation.get(start.conversationId) === turn) this.activeTurnsByConversation.delete(start.conversationId);
    });
    this.activeTurnsByConversation.set(start.conversationId, turn);
    return turn;
  }

  /** A mapper's answer, enqueued as the level it decided and the name it chose. */
  private mapped(result: MapperResult): void {
    this.enqueue(result.level as LogLevel, result.event ?? result.message ?? "", result.metadata);
  }

  private reportMapped(mapper: (report: never) => MapperResult, report: never): void {
    this.mapped(mapper(report));
  }

  reportAutoReviewApproval(r: Parameters<typeof autoReviewApprovalTelemetry>[0]): void {
    const mapped = autoReviewApprovalTelemetry(r);
    this.enqueue("info", mapped.event, mapped.metadata);
  }

  reportAutomationRun(r: Parameters<typeof automationRunTelemetry>[0]): void {
    this.reportMapped(automationRunTelemetry, r as never);
  }

  reportAutomationFireDropped(r: Parameters<typeof automationFireDroppedTelemetry>[0]): void {
    this.reportMapped(automationFireDroppedTelemetry, r as never);
  }

  reportAutomationShadowPrune(r: Parameters<typeof automationShadowPruneTelemetry>[0]): void {
    this.reportMapped(automationShadowPruneTelemetry, r as never);
  }

  reportConversationGc(r: Parameters<typeof conversationGcTelemetry>[0]): void {
    this.reportMapped(conversationGcTelemetry, r as never);
  }

  reportBoxDiskPressure(r: Parameters<typeof diskPressureReport>[0]): void {
    const mapped = diskPressureReport(r);
    this.enqueue(mapped.level as LogLevel, "slate.box.disk_pressure", mapped.metadata);
  }

  reportHostEventLoop(r: Parameters<typeof eventLoopWindowTelemetry>[0]): void {
    this.reportMapped(eventLoopWindowTelemetry, r as never);
  }

  reportExperimentsDiagnostic(r: Parameters<typeof experimentsDiagnosticTelemetry>[0]): void {
    this.reportMapped(experimentsDiagnosticTelemetry, r as never);
  }

  reportHostDiagnostic(r: Parameters<typeof hostDiagnosticTelemetry>[0]): void {
    this.reportMapped(hostDiagnosticTelemetry, r as never);
  }

  reportHostEventBusFailure(r: Parameters<typeof hostEventBusTelemetry>[0]): void {
    this.reportMapped(hostEventBusTelemetry, r as never);
  }

  reportHostExtensionDiagnostic(r: Parameters<typeof hostExtensionDiagnosticTelemetry>[0]): void {
    const mapped = hostExtensionDiagnosticTelemetry(r);
    // A diagnostic the mapper does not recognise is not a report.
    if (mapped !== undefined) this.mapped(mapped);
  }

  reportSessionDiagnostic(r: Parameters<typeof sessionDiagnosticTelemetry>[0]): void {
    this.reportMapped(sessionDiagnosticTelemetry, r as never);
  }

  reportSearchIndexHealth(r: Parameters<typeof searchIndexHealthTelemetry>[0]): void {
    this.reportMapped(searchIndexHealthTelemetry, r as never);
  }

  reportLocalExecRefused(r: Parameters<typeof localExecRefusedTelemetry>[0]): void {
    this.reportMapped(localExecRefusedTelemetry, r as never);
  }

  reportLocalExecProvider(r: Parameters<typeof localExecProviderTelemetry>[0]): void {
    this.reportMapped(localExecProviderTelemetry, r as never);
  }

  reportLocalExecFailed(r: Parameters<typeof localExecFailedTelemetry>[0]): void {
    this.reportMapped(localExecFailedTelemetry, r as never);
  }

  reportWebAuthnProxy(r: Parameters<typeof webauthnProxyTelemetry>[0]): void {
    this.reportMapped(webauthnProxyTelemetry, r as never);
  }

  reportMemorySynthesis(r: Parameters<typeof memorySynthesisTelemetry>[0]): void {
    this.reportMapped(memorySynthesisTelemetry, r as never);
  }

  reportHostStartup(metadata: Record<string, string>): void {
    this.mapped(hostStartupTelemetry(metadata, getHostBuiltAtMs()));
  }

  reportHostLifecycle(r: Parameters<typeof hostLifecycleTelemetry>[0]): void {
    this.reportMapped(hostLifecycleTelemetry, r as never);
  }

  reportDaemonPing(r: Parameters<typeof daemonPingTelemetry>[0]): void {
    this.reportMapped(daemonPingTelemetry, r as never);
  }

  reportBoxImageCheck(r: Parameters<typeof boxImageCheckTelemetry>[0]): void {
    this.reportMapped(boxImageCheckTelemetry, r as never);
  }

  /** What infrastructure happened to the box, when the mapper recognises the kind at all. */
  enqueueBoxInfrastructureEvent(event: Parameters<typeof boxInfrastructureTelemetry>[0], onSettled?: (settlement: "delivered" | "dropped") => void): void {
    const mapped = boxInfrastructureTelemetry(event);
    if ("level" in mapped && "event" in mapped && "metadata" in mapped) {
      this.enqueue(mapped.level as LogLevel, String(mapped.event), mapped.metadata as Metadata, onSettled);
    }
  }

  reportBoxBootStage(r: Fields): void {
    this.enqueueBoxInfrastructureEvent({ kind: "boot_stage", ...r } as Parameters<typeof boxInfrastructureTelemetry>[0]);
  }

  reportBoxBootFailure(r: Fields): void {
    this.enqueueBoxInfrastructureEvent({ kind: "boot_failure", ...r } as Parameters<typeof boxInfrastructureTelemetry>[0]);
  }

  reportEgressTunnel(r: Fields): void {
    this.enqueueBoxInfrastructureEvent({ kind: "egress_tunnel", ...r } as Parameters<typeof boxInfrastructureTelemetry>[0]);
  }

  reportHostBootFetch(r: Fields): void {
    this.enqueueBoxInfrastructureEvent({ kind: "host_boot_fetch", ...r } as Parameters<typeof boxInfrastructureTelemetry>[0]);
  }

  reportExecDaemonRestart(r: Fields): void {
    this.enqueueBoxInfrastructureEvent({ kind: "exec_daemon_restart", ...r } as Parameters<typeof boxInfrastructureTelemetry>[0]);
  }

  reportSupervisorRestart(r: Fields): void {
    this.enqueueBoxInfrastructureEvent({ kind: "supervisor_restart", ...r } as Parameters<typeof boxInfrastructureTelemetry>[0]);
  }

  /** A boot stage the host waits to hear about: promised only once it was actually handed over. */
  async reportBoxBootStageConfirmed(r: Fields): Promise<boolean> {
    const mapped = boxInfrastructureTelemetry({ kind: "boot_stage", ...r } as Parameters<typeof boxInfrastructureTelemetry>[0]);
    if (!("level" in mapped && "event" in mapped && "metadata" in mapped)) return false;
    return this.transport.shipConfirmed(mapped.level as LogLevel, String(mapped.event), mapped.metadata as Metadata);
  }

  reportTurnInterrupt(r: Parameters<typeof turnInterruptTelemetry>[0]): void {
    this.reportMapped(turnInterruptTelemetry, r as never);
  }

  reportTurnAwait(r: Parameters<typeof turnAwaitTelemetry>[0]): void {
    this.reportMapped(turnAwaitTelemetry, r as never);
  }

  reportTurnRetry(r: Parameters<typeof turnRetryTelemetry>[0]): void {
    // A retry belongs to the turn that is still running for that conversation.
    if (r.outcome === "retried") this.activeTurnsByConversation.get(String(r.conversationId))?.noteRetry(r);
    this.reportMapped(turnRetryTelemetry, r as never);
  }

  reportUserMessageReceived(r: Parameters<typeof userMessageReceivedTelemetry>[0]): void {
    this.reportMapped(userMessageReceivedTelemetry, r as never);
  }

  reportClosingSendNudge(r: Parameters<typeof closingSendNudgeTelemetry>[0]): void {
    this.reportMapped(closingSendNudgeTelemetry, r as never);
  }

  reportSubagentRevival(r: Parameters<typeof subagentRevivalTelemetry>[0]): void {
    this.reportMapped(subagentRevivalTelemetry, r as never);
  }

  reportShellRevival(r: Parameters<typeof shellRevivalTelemetry>[0]): void {
    this.reportMapped(shellRevivalTelemetry, r as never);
  }

  reportTtft(r: Parameters<typeof ttftTelemetry>[0]): void {
    this.reportMapped(ttftTelemetry, r as never);
  }

  reportSendDispatch(r: Parameters<typeof sendDispatchTelemetry>[0]): void {
    this.reportMapped(sendDispatchTelemetry, r as never);
  }

  reportQueueAccepted(r: Parameters<typeof queueAcceptedTelemetry>[0]): void {
    this.reportMapped(queueAcceptedTelemetry, r as never);
  }

  reportQueueDequeued(r: Parameters<typeof queueDequeuedTelemetry>[0]): void {
    this.reportMapped(queueDequeuedTelemetry, r as never);
  }

  reportQueueWatchdog(r: Parameters<typeof queueWatchdogTelemetry>[0]): void {
    this.reportMapped(queueWatchdogTelemetry, r as never);
  }

  reportAckObligation(r: Parameters<typeof ackObligationTelemetry>[0]): void {
    this.reportMapped(ackObligationTelemetry, r as never);
  }

  reportPendingWake(r: Parameters<typeof pendingWakeTelemetry>[0]): void {
    this.reportMapped(pendingWakeTelemetry, r as never);
  }

  reportTurnUsage(r: Parameters<typeof turnUsageTelemetry>[0]): void {
    this.reportMapped(turnUsageTelemetry, r as never);
  }

  reportTurnEmptyDelivery(r: Parameters<typeof turnEmptyDeliveryTelemetry>[0]): void {
    this.reportMapped(turnEmptyDeliveryTelemetry, r as never);
  }

  reportJournalOutcome(r: Parameters<typeof journalOutcomeTelemetry>[0]): void {
    this.reportMapped(journalOutcomeTelemetry, r as never);
  }

  reportComputerUseUsage(r: Parameters<typeof computerUseUsageTelemetry>[0]): void {
    this.reportMapped(computerUseUsageTelemetry, r as never);
  }

  /** What a tool call was, which three of its reports share. */
  private toolCallTags(r: Fields): Metadata {
    return {
      conversation_id: String(r.conversationId),
      request_id: r.requestId as string | undefined,
      tool_name: r.toolName as string | undefined,
      tool_call_id: r.toolCallId as string | undefined,
    };
  }

  reportToolCallError(r: Fields): void {
    this.enqueue("error", TOOL_CALL_ERROR_EVENT, {
      ...this.toolCallTags(r),
      error_class: r.errorClass as string | undefined,
      duration_ms: r.durationMs !== undefined ? cappedToolCallMs(r.durationMs as number) : undefined,
      connector: r.connector as string | undefined,
    });
  }

  reportToolCallStalled(r: Fields): void {
    this.enqueue("warn", TOOL_CALL_STALLED_EVENT, {
      ...this.toolCallTags(r),
      connector: r.connector as string | undefined,
      elapsed_ms: cappedToolCallMs(r.elapsedMs as number),
    });
  }

  reportToolCallStarted(r: Fields): void {
    this.enqueue("info", TOOL_CALL_STARTED_EVENT, {
      ...this.toolCallTags(r),
      surface: r.surface as string | undefined,
    });
  }

  reportAgentError(report: { source: string; conversationId: string; requestId?: string; error: SlateErrorValue; detail?: { message: string; stack?: string } }): void {
    this.enqueue("error", AGENT_ERROR_EVENT, {
      source: report.source,
      conversation_id: report.conversationId,
      request_id: report.requestId,
      ...slateErrorTags(report.error),
    });
    if (report.detail !== undefined) {
      this.enqueue("error", AGENT_ERROR_DETAIL_EVENT, {
        source: report.source,
        conversation_id: report.conversationId,
        request_id: report.requestId,
        ...errorDetailTags(report.error, report.detail),
      });
    }
  }

  reportAutoReviewDisplayRecheckFailed(report: { conversationId: string }): void {
    this.enqueue("info", AUTO_REVIEW_DISPLAY_RECHECK_FAILED_EVENT, { conversation_id: report.conversationId, surface: "computer" });
  }

  reportAutoReviewExpireSweepFailed(report: { stage: string; errorClass: string }): void {
    this.enqueue("warn", AUTO_REVIEW_EXPIRE_SWEEP_FAILED_EVENT, { stage: report.stage, error_class: report.errorClass });
  }

  reportBoxStoreSyncCycle(level: LogLevel, metadata: Metadata): void {
    this.enqueue(level, BOX_STORE_SYNC_EVENT, metadata);
  }

  reportBoxStoreDbCapture(level: LogLevel, metadata: Metadata): void {
    this.enqueue(level, BOX_STORE_DB_CAPTURE_EVENT, metadata);
  }

  reportBoxStoreManifestConflict(level: LogLevel, metadata: Metadata): void {
    this.enqueue(level, BOX_STORE_MANIFEST_CONFLICT_EVENT, metadata);
  }

  reportChromeSessionStage(level: LogLevel, metadata: Metadata): void {
    this.enqueue(level, CHROME_SESSION_STAGE_EVENT, metadata);
  }

  reportMcpAuthCleanup(outcome: "ok" | "error", removedCount: number): void {
    this.enqueue(outcome === "error" ? "warn" : "info", MCP_AUTH_CLEANUP_EVENT, { outcome, removed_count: String(removedCount) });
  }

  reportMcpDiscoveryFailed(report: { errorClass: string; elapsedMs: number; servedStale: boolean }): void {
    this.enqueue("warn", MCP_DISCOVERY_FAILED_EVENT, {
      error_class: report.errorClass,
      elapsed_ms: String(Math.round(report.elapsedMs)),
      served_stale: String(report.servedStale),
    });
  }

  reportConnectorAuth(report: ConnectorAuthReport): void {
    const mapped = connectorAuthTelemetry(report, "host");
    this.enqueue(mapped.level, CONNECTOR_AUTH_EVENT, mapped.metadata);
  }

  reportLocalToolPermissionStrandedRetirement(): void {
    this.enqueue("warn", CLIENT_RESOURCE_EVENT, {
      domain: "permissions",
      operation: "resolveLocalToolPermission",
      state: "failed",
      failure_code: "permissions/stranded-ask-retired",
      boundary: "host",
      retry_owner: "none",
    });
  }

  reportSkillPublishEdgeFailed(report: { stage: string; errorClass: string }): void {
    this.enqueue("warn", SKILL_PUBLISH_EDGE_FAILED_EVENT, { stage: report.stage, error_class: report.errorClass });
  }

  reportPluginSkillsSync(report: { trigger: string; outcome: string; changed?: boolean; skillCount?: number; errorClass?: string; durationMs: number }): void {
    this.enqueue(report.outcome === "failed" ? "warn" : "info", PLUGIN_SKILLS_SYNC_EVENT, {
      trigger: report.trigger,
      outcome: report.outcome,
      changed: asText(report.changed),
      skill_count: asText(report.skillCount),
      error_class: report.errorClass,
      duration_ms: String(Math.round(report.durationMs)),
    });
  }

  reportTeachRecordingCapStopFailed(report: { errorClass: string }): void {
    this.enqueue("warn", TEACH_RECORDING_CAP_STOP_FAILED_EVENT, { error_class: report.errorClass });
  }

  reportTeachRecordingStartFailed(report: { kind: string; errorClass: string; windowIndex?: number; entryPoint?: string }): void {
    this.enqueue("warn", TEACH_RECORDING_START_FAILED_EVENT, {
      kind: report.kind,
      error_class: report.errorClass,
      window_index: asText(report.windowIndex),
      entry_point: report.entryPoint,
    });
  }

  reportBoxCopyIn(level: LogLevel, metadata: Metadata): void {
    this.enqueue(level, BOX_COPY_IN_EVENT, metadata);
  }

  reportBoxRecreateDecided(metadata: Metadata): void {
    this.enqueue("info", BOX_RECREATE_DECIDED_EVENT, metadata);
  }

  reportInferenceCredentialRenewal(level: LogLevel, metadata: Metadata): void {
    this.enqueue(level, INFERENCE_CREDENTIAL_RENEWAL_EVENT, metadata);
  }

  reportGatewayCommandError(level: LogLevel, metadata: Metadata): void {
    this.enqueue(level, GATEWAY_COMMAND_ERROR_EVENT, metadata);
  }

  reportGatewayCommandTiming(level: LogLevel, metadata: Metadata): void {
    this.enqueue(level, GATEWAY_COMMAND_TIMING_EVENT, metadata);
  }

  reportAutomationLifecycle(report: {
    conversationId: string;
    automationId: string;
    action: string;
    source: string;
    triggerType: string;
    scheduledFiresNext7Days?: number | null;
    firesOnWeekend?: boolean | null;
    firesOvernight?: boolean | null;
    ageMs: number;
    recordedRunCount: number;
  }): void {
    this.enqueue("info", AUTOMATION_LIFECYCLE_EVENT, {
      conversation_id: report.conversationId,
      automation_id: report.automationId,
      action: report.action,
      source: report.source,
      trigger_type: report.triggerType,
      scheduled_fires_next_7_days: asPresentText(report.scheduledFiresNext7Days),
      fires_on_weekend: asPresentText(report.firesOnWeekend),
      fires_overnight: asPresentText(report.firesOvernight),
      age_ms: String(report.ageMs),
      recorded_run_count: String(report.recordedRunCount),
    });
  }

  reportHostLog(level: LogLevel, line: string, metadata: Metadata = {}): void {
    this.enqueue(level, HOST_LOG_EVENT, { text: truncateStructuredLogValue(line, MAX_HOST_LOG_LENGTH), ...metadata });
  }

  reportBoxLogBatch(records: Array<{ kind: string; source?: string; line?: string; event?: Fields }>, onEntrySettled: (settlement: "delivered" | "dropped") => void): void {
    for (const record of records) {
      if (record.kind === "log") {
        this.enqueue("info", BOX_LOG_EVENT, { source: record.source, text: truncateStructuredLogValue(record.line ?? "", MAX_HOST_LOG_LENGTH) }, onEntrySettled);
      } else if (record.kind === "infrastructure" && record.event !== undefined) {
        this.enqueueBoxInfrastructureEvent(record.event as Parameters<typeof boxInfrastructureTelemetry>[0], onEntrySettled);
      }
    }
  }

  reportBoxLogShip(r: Parameters<typeof boxLogShipTelemetry>[0], onSettled?: (settlement: "delivered" | "dropped") => void): void {
    const mapped = boxLogShipTelemetry(r);
    this.enqueue(mapped.level as LogLevel, mapped.message, mapped.metadata, onSettled);
  }

  reportDesktopHealth(level: LogLevel, metadata: Metadata): void {
    this.enqueue(level, DESKTOP_HEALTH_EVENT, metadata);
  }

  reportAgentOpen(report: { conversationId: string; durationMs: number; entryCount: number; wasActive: boolean }): void {
    this.enqueue("info", AGENT_OPEN_EVENT, {
      conversation_id: report.conversationId,
      duration_ms: String(report.durationMs),
      entry_count: String(report.entryCount),
      was_active: String(report.wasActive),
    });
  }

  reportHostCrash(kind: string): void {
    this.enqueue("error", HOST_CRASH_EVENT, { kind });
  }

  /** A host crash the caller waits to hear was recorded: it is only true once it was handed over. */
  async reportHostProcessExitConfirmed(marker: HostCrashMarker): Promise<boolean> {
    return this.transport.shipConfirmed("error", HOST_CRASH_EVENT, {
      ...hostCrashMarkerMetadata(marker),
      error_code: "SLATE-E0001",
      error_domain: "registry",
      error_retryable: "false",
    });
  }

  reportInvariantViolation({ name }: { name: string }): void {
    this.enqueue("error", HOST_INVARIANT_VIOLATION_EVENT, { name });
  }

  reportHostUpgrade(metadata: Metadata & { outcome: string }): void {
    this.enqueue(metadata.outcome === "failed" ? "warn" : "info", HOST_UPGRADE_EVENT, metadata);
  }

  async reportHostUpgradeConfirmed(metadata: Metadata & { outcome: string }): Promise<boolean> {
    return await this.transport.shipConfirmed(metadata.outcome === "failed" ? "warn" : "info", HOST_UPGRADE_EVENT, metadata);
  }

  reportBoxHelp(report: { conversationId: string; snapshotCaptured: boolean; reason: string }): void {
    this.enqueue("info", BOX_HELP_EVENT, {
      conversation_id: report.conversationId,
      snapshot_captured: String(report.snapshotCaptured),
      "meta.reason": report.reason,
    });
  }

  /** A blocked page is reported twice: what happened, and where it happened. */
  reportBotBlock(report: { conversationId: string; family: string; confidence: string; blockedHost: string; blockedUrl: string }): void {
    this.enqueue("warn", BOT_BLOCK_EVENT, { conversation_id: report.conversationId, family: report.family, confidence: report.confidence });
    this.enqueue("warn", BOT_BLOCK_DETAIL_EVENT, { conversation_id: report.conversationId, family: report.family, blocked_host: report.blockedHost, blocked_url: report.blockedUrl });
  }

  emitTurnEvent(event: string, metadata: Metadata): void {
    this.enqueue("info", event, metadata);
  }

  setFlushTickListener(listener?: () => void): void {
    this.transport.setFlushTickListener(listener);
  }

  async dispose(): Promise<void> {
    await this.transport.dispose();
  }

  /** The one door into the transport: nothing without a value reaches it, and everything with one goes as text. */
  enqueue(level: LogLevel, message: string, metadata: Record<string, unknown>, onSettled?: (settlement: "delivered" | "dropped") => void): void {
    const cleaned: Metadata = {};
    for (const [key, value] of Object.entries(metadata)) {
      if (value !== undefined) cleaned[key] = String(value);
    }
    this.transport.enqueue(level, message, cleaned, onSettled);
  }
}

/** One turn: it starts once its model is known, counts its retries, and ends exactly once. */
export class SlateTurnTelemetryImpl {
  private readonly startedAt = Date.now();
  private model: string | undefined;
  private requestId: string | undefined;
  private startEmitted = false;
  private finalized = false;
  private retryCount = 0;
  private backoffTotalMs = 0;
  private retryCause: string | undefined;

  constructor(
    private readonly telemetry: SlateStructuredLogTelemetry,
    private readonly start: { conversationId: string; turnType: string; model?: string },
    private readonly onFinalized: () => void,
  ) {
    this.model = start.model;
    if (this.model !== undefined) this.emitStart();
  }

  noteRetry(report: Record<string, unknown>): void {
    if (this.finalized) return;
    this.retryCount += 1;
    this.backoffTotalMs += typeof report.delayMs === "number" ? report.delayMs : 0;
    if (typeof report.cause === "string") this.retryCause = report.cause;
  }

  setModel(modelId: string): void {
    if (modelId.length === 0) return;
    this.model = modelId;
    this.emitStart();
  }

  setRequestId(requestId: string): void {
    // The first request that asked is the one a turn is known by.
    if (this.requestId === undefined && requestId.length > 0) this.requestId = requestId;
  }

  finalize(outcome: string, error?: SlateErrorValue, detail?: { message: string; stack?: string }): void {
    if (this.finalized) return;
    this.finalized = true;
    this.onFinalized();
    this.emitStart();
    const metadata: Metadata = {
      ...this.baseTags(),
      // A turn that carried an error ended in one, whatever the caller called the outcome.
      outcome: error !== undefined ? "error" : outcome,
      duration_ms: String(Date.now() - this.startedAt),
    };
    if (this.retryCount > 0) {
      metadata.retry_count = String(this.retryCount);
      metadata.backoff_total_ms = String(Math.round(this.backoffTotalMs));
      metadata.retry_cause = this.retryCause;
    }
    if (error !== undefined) Object.assign(metadata, slateErrorTags(error));
    this.telemetry.emitTurnEvent(TURN_OUTCOME_EVENT, metadata);
    if (error !== undefined && detail !== undefined) {
      this.telemetry.emitTurnEvent(TURN_OUTCOME_DETAIL_EVENT, { ...this.baseTags(), ...errorDetailTags(error, detail) });
    }
  }

  baseTags(): Metadata {
    return { turn_type: this.start.turnType, conversation_id: this.start.conversationId, request_id: this.requestId, model_intent: this.model };
  }

  private emitStart(): void {
    if (this.startEmitted) return;
    this.startEmitted = true;
    this.telemetry.emitTurnEvent(TURN_START_EVENT, this.baseTags());
  }
}
