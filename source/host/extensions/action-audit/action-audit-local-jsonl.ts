import type { AuditRecord } from "./action-audit-contracts.ts";

/** Render one locally retained line; the compact record deliberately excludes credentials and shell decisions. */
export function localAuditJsonlLine(record: AuditRecord, eventId: string): string {
  const common = {
    ts: new Date(record.occurredAtMs).toISOString(),
    agentId: record.agentId,
    eventId,
    ...(record.turnId ? { turnId: record.turnId } : {}),
  };

  switch (record.action.kind) {
    case "mcpToolCall":
      return `${JSON.stringify({
        ...common,
        type: "mcp_tool_call",
        serverIdentifier: record.action.serverIdentifier,
        toolName: record.action.toolName,
        toolCallId: record.action.toolCallId,
        transport: record.action.transport,
        status: record.action.status,
        durationMs: record.action.durationMs,
      })}\n`;
    case "browserNavigation":
      return `${JSON.stringify({
        ...common,
        type: "browser_navigation",
        url: record.action.url,
        pageTitle: record.action.pageTitle,
      })}\n`;
    case "computerUseSession":
      return `${JSON.stringify({
        ...common,
        type: "computer_use_session",
        toolCallId: record.action.toolCallId ?? "",
        actionCount: record.action.actionCount,
        actionCounts: record.action.actionCounts,
        durationMs: record.action.durationMs,
        screenshotCount: record.action.screenshotCount,
      })}\n`;
    case "shellCommand":
      return `${JSON.stringify({
        ...common,
        type: "shell_command",
        command: record.action.command,
        shellKind: record.action.shellKind,
        target: record.action.target,
      })}\n`;
  }
}
