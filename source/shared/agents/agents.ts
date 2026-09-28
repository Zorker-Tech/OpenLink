/**
 * The agents the platform runs for itself.
 *
 * There are few of them and their purposes are named here — saving disk space, authorizing a plugin — so a caller can
 * tell an agent the platform runs from one the user started.
 */
export const SLATE_AGENT_PURPOSES = ["disk-saver", "plugin-auth"] as const;
export type SlateAgentPurpose = (typeof SLATE_AGENT_PURPOSES)[number];

export function isSlateAgentPurpose(value: unknown): value is SlateAgentPurpose {
  return (
    typeof value === "string" &&
    (SLATE_AGENT_PURPOSES as readonly string[]).includes(value)
  );
}

const TEMPLATE_ID_PATTERN = /^[a-z0-9-]{1,64}$/;

export function sanitizeTemplateId(value: unknown): string | undefined {
  return typeof value === "string" && TEMPLATE_ID_PATTERN.test(value)
    ? value
    : undefined;
}

export interface SlateAgentActivity {
  readonly kind?: string;
  readonly tool?: string;
  readonly detail?: string;
  readonly target?: string;
  readonly callId?: string;
}

export function areAgentActivitiesEqual(
  left: SlateAgentActivity | null | undefined,
  right: SlateAgentActivity | null | undefined,
): boolean {
  if (left === right) return true;
  if (left == null || right == null) return false;
  return (
    left.kind === right.kind &&
    left.tool === right.tool &&
    left.detail === right.detail &&
    left.target === right.target &&
    left.callId === right.callId
  );
}

export const SLATE_DEFAULT_AGENT_NAME = "New Bot";
export const LEGACY_SLATE_DEFAULT_AGENT_NAME = "New Agent";

export function isSlateDefaultAgentName(name: string): boolean {
  const trimmed = name.trim();
  return (
    trimmed === SLATE_DEFAULT_AGENT_NAME ||
    trimmed === LEGACY_SLATE_DEFAULT_AGENT_NAME
  );
}

export const GROUP_MAX_MEMBERS = 6;
export const MAX_AGENTS_PER_USER = 50;
export const SLATE_AGENT_LIMIT_MESSAGE = `${MAX_AGENTS_PER_USER} is the maximum`;

export class SlateAgentLimitError extends Error {
  constructor() {
    super(SLATE_AGENT_LIMIT_MESSAGE);
    this.name = "SlateAgentLimitError";
  }
}

export function isSlateAgentLimitError(error: unknown): boolean {
  return error instanceof Error && error.message === SLATE_AGENT_LIMIT_MESSAGE;
}
