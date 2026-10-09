/**
 * The audit events that go to the backend.
 *
 * A recorded action is turned into the platform's own event shape — the same action, named the way the backend names
 * it, with the counts and durations it takes as whole non-negative numbers — and the events of a batch are sent
 * together, through the host's own account. A batch with nothing in it is not a request.
 */

import type { MethodInfoUnary } from "@bufbuild/protobuf";
import { DashboardService } from "../../../packages/proto/generated/aiserver/v1/dashboard_connect.ts";
import {
  RecordSlateAuditEventsRequest,
  type RecordSlateAuditEventsResponse,
  SlateAuditEvent,
  SlateAuditEvent_BrowserNavigation,
  SlateAuditEvent_ComputerUseSession,
  SlateAuditEvent_McpToolCall,
  SlateAuditEvent_ShellCommand,
} from "../../../packages/proto/generated/aiserver/v1/dashboard_pb.ts";
import { createSlateCursorBackendClient } from "../../../shared/node/cursor-backend/cursor-inference.ts";
import type { AuditEvent } from "./action-audit-service.ts";

/** A count or a duration, as the wire takes it: whole, and never negative. */
const wireCount = (value: number): bigint => BigInt(Math.max(0, Math.round(value)));

export function toProtoAuditEventData(event: AuditEvent): SlateAuditEvent {
  const action = event.action;
  const base = { eventId: event.eventId, occurredAtMs: wireCount(event.occurredAtMs), agentId: event.agentId, turnId: event.turnId, boxId: event.boxId };
  switch (action.kind) {
    case "mcpToolCall":
      return new SlateAuditEvent({
        ...base,
        action: {
          case: "mcpToolCall",
          value: new SlateAuditEvent_McpToolCall({
            toolCallId: action.toolCallId,
            serverIdentifier: action.serverIdentifier,
            serverName: action.serverName!,
            toolName: action.toolName,
            status: action.status,
            durationMs: wireCount(action.durationMs),
          }),
        },
      });
    case "shellCommand": {
      const allowed = action.allowed ?? true;
      return new SlateAuditEvent({
        ...base,
        action: {
          case: "shellCommand",
          value: new SlateAuditEvent_ShellCommand({
            command: action.command,
            kind: action.shellKind,
            target: action.target,
            allowed,
            // What a command was blocked for is only worth sending when it was blocked.
            blockedReason: allowed ? "" : action.blockedReason ?? "",
            classificationReasons: [...action.classificationReasons ?? []],
          }),
        },
      });
    }
    case "browserNavigation":
      return new SlateAuditEvent({
        ...base,
        action: {
          case: "browserNavigation",
          value: new SlateAuditEvent_BrowserNavigation({ url: action.url, pageTitle: action.pageTitle }),
        },
      });
    case "computerUseSession": {
      const actionCounts: Record<string, bigint> = {};
      for (const [kind, count] of Object.entries(action.actionCounts)) actionCounts[kind] = wireCount(count);
      return new SlateAuditEvent({
        ...base,
        action: {
          case: "computerUseSession",
          value: new SlateAuditEvent_ComputerUseSession({
            toolCallId: action.toolCallId ?? "",
            actionCount: wireCount(action.actionCount),
            actionCounts,
            durationMs: wireCount(action.durationMs),
            screenshotCount: wireCount(action.screenshotCount),
          }),
        },
      });
    }
  }
}

/** Sends recorded actions to the backend in batches, on the host's own account. */
export function createSlateAuditBatchSender(deps: {
  readonly getAccessToken: (options: { readonly backendUrl: string }) => Promise<string>;
  readonly getMachineId: () => Promise<string>;
}): (events: readonly AuditEvent[]) => Promise<void> {
  // The generated service type does not carry this method, though the backend serves it.
  const service = DashboardService as typeof DashboardService & {
    readonly methods: typeof DashboardService.methods & {
      readonly recordSlateAuditEvents: MethodInfoUnary<RecordSlateAuditEventsRequest, RecordSlateAuditEventsResponse>;
    };
  };
  const client = createSlateCursorBackendClient(service, { getAccessToken: deps.getAccessToken, getMachineId: deps.getMachineId });
  return async (events) => {
    if (events.length === 0) return;
    await client.recordSlateAuditEvents(new RecordSlateAuditEventsRequest({ events: events.map(toProtoAuditEventData) }));
  };
}
