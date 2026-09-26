/**
 * The one line a message is shown as before it is opened.
 *
 * A surface shows a message by its sender and its first line, and what a sender looks like depends on what it is: the
 * user, another agent, a channel, or one of the platform's own cloud agents — with a fallback for a cloud agent that
 * has not said its name yet.
 */
export const SLATE_AGENT_FALLBACK_PREVIEW = "Slate cloud agent";

export function slateAgentPreviewText(title?: string | null): string {
  const trimmed = title?.trim();
  return trimmed != null && trimmed.length > 0
    ? `Slate agent: ${trimmed}`
    : SLATE_AGENT_FALLBACK_PREVIEW;
}

export function connectorsPreviewText(connectors: readonly string[]): string {
  return connectors.length > 0
    ? `Connect ${connectors.join(", ")}`
    : "Connect tools";
}

export type SendMessagePreviewInput =
  | { readonly type: "text"; readonly content: string }
  | { readonly type: "attachment"; readonly url: string }
  | { readonly type: "widget"; readonly widget: { readonly prompt: string } }
  | { readonly type: "slate-agent"; readonly title?: string | null }
  | {
      readonly type: "secret-request";
      readonly secretRequest: { readonly label: string };
    }
  | {
      readonly type: "email-draft";
      readonly draft: { readonly subject: string; readonly body: string };
    }
  | { readonly type: "slack-draft"; readonly draft: { readonly body: string } }
  | {
      readonly type: "permission-request";
      readonly permission: { readonly title: string };
    }
  | {
      readonly type: "auto-review-approval";
      readonly approval: { readonly summary: string };
    }
  | {
      readonly type: "local-tool-permission";
      readonly ask: { readonly target: string };
    }
  | {
      readonly type: "connector";
      readonly variant: string;
      readonly connector: string;
    }
  | { readonly type: "connectors"; readonly connectors: readonly string[] }
  | {
      readonly type: "listener-connect";
      readonly platform: string;
    };

export function sendMessagePreviewText(message: SendMessagePreviewInput): string {
  switch (message.type) {
    case "text":
      return message.content;
    case "attachment":
      return message.url;
    case "widget":
      return message.widget.prompt;
    case "slate-agent":
      return slateAgentPreviewText(message.title);
    case "secret-request":
      return message.secretRequest.label;
    case "email-draft":
      return message.draft.subject || message.draft.body;
    case "slack-draft":
      return message.draft.body;
    case "permission-request":
      return message.permission.title;
    case "auto-review-approval":
      return `Approval required: ${message.approval.summary}`;
    case "local-tool-permission":
      return `Permission required: ${message.ask.target}`;
    case "connector":
      return message.variant === "connected"
        ? `${message.connector} connected`
        : `Connect ${message.connector}`;
    case "connectors":
      return connectorsPreviewText(message.connectors);
    case "listener-connect":
      return `Connect ${message.platform === "slack" ? "Slack" : "GitHub"}`;
  }
  return "Message";
}
