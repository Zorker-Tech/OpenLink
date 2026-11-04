import { summarizeWidget } from "../../../shared/slate-widgets.ts";
import { summarizePermissionRequest } from "./slate-permission-request.ts";
import { summarizeSecretRequest } from "./slate-secret-request.ts";
import type { EncodableMessage } from "./send-message-encoding-contracts.ts";

export function summarizeProductMessage(message: EncodableMessage): string | undefined {
  switch (message.type) {
    case "widget":
      return summarizeWidget(message.widget as { prompt?: unknown; options?: unknown });
    case "secret-request":
      return summarizeSecretRequest((message.secretRequest ?? message.secret) as { label: string });
    case "permission-request":
      return summarizePermissionRequest(message.permission as { title: string; reason: string });
    case "auto-review-approval": {
      const approval = message.approval as Record<string, unknown>;
      return `Auto-review requested approval for: ${String(approval.summary)}. Status: ${String(approval.status)}.`;
    }
    case "local-tool-permission": {
      const ask = message.ask as Record<string, unknown>;
      return `Asked the user for permission to use their computer (${String(ask.action)}: ${String(ask.target)}). Status: ${String(ask.status)}.`;
    }
    case "connector":
      return message.variant === "connected"
        ? `Confirmed the ${String(message.connector)} connector is connected`
        : `Asked the user to connect the ${String(message.connector)} connector`;
    case "connectors":
      return `Asked the user to connect: ${(message.connectors as readonly string[]).join(", ")}`;
    case "listener-connect":
      return `Asked the user to connect ${message.platform === "slack" ? "Slack" : "GitHub"} for listener routines`;
    case "email-draft": {
      const draft = message.draft as { from?: string; to: readonly string[]; cc?: readonly string[]; subject: string; body: string };
      const copyList = draft.cc?.join(", ");
      return `Draft email${draft.from == null ? "" : `\nFrom: ${draft.from}`}\nTo: ${draft.to.join(", ")}${copyList == null ? "" : `\nCc: ${copyList}`}\nSubject: ${draft.subject}\n\n${draft.body}`;
    }
    case "slack-draft": {
      const draft = message.draft as { workspace?: string; target: string; thread?: string; body: string };
      const workspace = draft.workspace == null ? "" : ` in ${draft.workspace}`;
      return `Draft Slack message${workspace} to ${draft.target}\nThread: ${draft.thread ?? "New message"}\n\n${draft.body}`;
    }
    default:
      return undefined;
  }
}
