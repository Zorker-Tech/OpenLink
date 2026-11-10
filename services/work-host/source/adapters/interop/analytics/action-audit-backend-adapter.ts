/** Project Slate audit records into the generated dashboard event batch. */

import type { MethodInfoUnary } from "@bufbuild/protobuf"
import { DashboardService } from "../proto/generated/aiserver/v1/dashboard_connect.ts"
import {
  RecordSlateAuditEventsRequest,
  type RecordSlateAuditEventsResponse,
  SlateAuditEvent,
  SlateAuditEvent_BrowserNavigation,
  SlateAuditEvent_ComputerUseSession,
  SlateAuditEvent_McpToolCall,
  SlateAuditEvent_ShellCommand,
} from "../proto/generated/aiserver/v1/dashboard_pb.ts"
import { createSlateBackendClient } from "../slate-backend/slate-backend-client.ts"
import type { AuditEvent } from "../../../host/extensions/action-audit/action-audit-service.ts"

/** A count or duration accepted by the backend: whole, and never negative. */
const wireCount = (value: number): bigint => BigInt(Math.max(0, Math.round(value)))

export function toProtoAuditEventData(event: AuditEvent): SlateAuditEvent {
  const action = event.action
  const base = {
    eventId: event.eventId,
    occurredAtMs: wireCount(event.occurredAtMs),
    agentId: event.agentId,
    turnId: event.turnId,
    boxId: event.boxId,
  }
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
      })
    case "shellCommand": {
      const allowed = action.allowed ?? true
      return new SlateAuditEvent({
        ...base,
        action: {
          case: "shellCommand",
          value: new SlateAuditEvent_ShellCommand({
            command: action.command,
            kind: action.shellKind,
            target: action.target,
            allowed,
            blockedReason: allowed ? "" : action.blockedReason ?? "",
            classificationReasons: [...action.classificationReasons ?? []],
          }),
        },
      })
    }
    case "browserNavigation":
      return new SlateAuditEvent({
        ...base,
        action: {
          case: "browserNavigation",
          value: new SlateAuditEvent_BrowserNavigation({ url: action.url, pageTitle: action.pageTitle }),
        },
      })
    case "computerUseSession": {
      const actionCounts: Record<string, bigint> = {}
      for (const [kind, count] of Object.entries(action.actionCounts)) actionCounts[kind] = wireCount(count)
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
      })
    }
  }
}

/** Send recorded actions in batches using the host account's credentials. */
export function createSlateAuditBatchSender(deps: {
  readonly getAccessToken: (options: { readonly backendUrl: string }) => Promise<string>
  readonly getMachineId: () => Promise<string>
}): (events: readonly AuditEvent[]) => Promise<void> {
  const service = DashboardService as typeof DashboardService & {
    readonly methods: typeof DashboardService.methods & {
      readonly recordSlateAuditEvents: MethodInfoUnary<RecordSlateAuditEventsRequest, RecordSlateAuditEventsResponse>
    }
  }
  const client = createSlateBackendClient(service, {
    getAccessToken: deps.getAccessToken,
    getMachineId: deps.getMachineId,
  })
  return async events => {
    if (events.length === 0) return
    await client.recordSlateAuditEvents(new RecordSlateAuditEventsRequest({ events: events.map(toProtoAuditEventData) }))
  }
}
