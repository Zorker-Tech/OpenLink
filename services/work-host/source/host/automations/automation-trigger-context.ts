const EVENT_LABELS: Readonly<Record<string, string>> = {
  "pr-opened": "PR opened",
  "pr-pushed": "PR updated",
  "pr-merged": "PR merged",
  "review-requested": "Review requested",
  "review-approved": "Review approved",
  "review-changes-requested": "Changes requested",
  "review-commented": "Review commented",
  "pr-comment": "PR comment",
  "inline-review-comment": "Inline review comment",
  "review-thread-resolved": "Review thread resolved",
  "review-thread-unresolved": "Review thread reopened",
  "issue-assigned": "Issue assigned",
  "ci-passed": "CI passed",
  "ci-failed": "CI failed",
  issueCreated: "Issue created",
  statusChanged: "Issue status changed",
  endOfCycle: "Cycle ended",
  incidentTriggered: "Incident triggered",
};

function boundedLine(value: unknown): string {
  return typeof value === "string" ? value.replace(/[\r\n]+/g, " ").trim().slice(0, 120) : "";
}

export function describeTriggerEvent(event: Record<string, unknown>): string {
  if (event.source === "slack") {
    if (event.reactionEmoji != null) return `${event.sender} reacted ${event.reactionEmoji} in ${event.channel}`;
    return `${event.sender} in ${event.channel}: "${boundedLine(event.text)}"`;
  }
  if (event.source === "github") {
    const label = EVENT_LABELS[event.kind as string] ?? event.kind;
    return `${label} in ${event.repo}: "${boundedLine(event.title)}" by ${event.actor}`;
  }
  const label = EVENT_LABELS[event.event as string] ?? event.event;
  return `${label}: "${boundedLine(event.title ?? event.cycleName ?? event.issueIdentifier)}"`;
}

function escapeMarkup(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function buildTriggerEventContextBlock(event: Record<string, unknown>): string {
  const tagBySource: Readonly<Record<string, string>> = {
    slack: "slack_message",
    github: "github_event",
    microsoftTeams: "microsoft_teams_message",
    linear: "linear_event",
    sentry: "sentry_event",
    pagerduty: "pagerduty_event",
  };
  const tag = tagBySource[event.source as string] ?? "trigger_event";
  const json = JSON.stringify(event, null, 2);
  return `<${tag}>\n${escapeMarkup(json)}\n</${tag}>`;
}
