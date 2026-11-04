import { MAX_NOTIFICATION_BODY_LENGTH, type NotificationTransition } from "./os-notification-contracts.ts";

function compactBody(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function fitBody(text: string): string {
  const compact = compactBody(text);
  if (compact.length <= MAX_NOTIFICATION_BODY_LENGTH) return compact;
  return `${compact.slice(0, MAX_NOTIFICATION_BODY_LENGTH - 1).trimEnd()}…`;
}

/** Build the operating-system title and body from a Slate notification transition. */
export function buildNotificationContent(transition: NotificationTransition): { title: string; body: string } {
  const name = transition.agentName.trim() || "Your agent";
  if (transition.kind === "agent-needs-input") {
    const reason = transition.reason?.trim() ?? "";
    return {
      title: `${name} needs you`,
      body: reason ? fitBody(reason) : "Waiting for your input.",
    };
  }

  const summary = transition.lastMessagePreview?.trim() ?? "";
  return {
    title: name,
    body: summary ? fitBody(summary) : "Open Slate to see what it did.",
  };
}
