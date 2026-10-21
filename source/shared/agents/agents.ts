/**
 * The agents the platform runs for itself.
 *
 * There are few of them and their purposes are named here — saving disk space, authorizing a plugin — so a caller can
 * tell an agent the platform runs from one the user started.
 */

/** The agents this platform runs for itself, by purpose. */
export const SLATE_AGENT_PURPOSES = ["disk-saver", "plugin-auth"] as const;

export type SlateAgentPurpose = (typeof SLATE_AGENT_PURPOSES)[number];

const AGENT_PURPOSES: ReadonlySet<string> = new Set(SLATE_AGENT_PURPOSES);

export function isSlateAgentPurpose(value: unknown): value is SlateAgentPurpose {
  return typeof value === "string" && AGENT_PURPOSES.has(value);
}

/** A template id is what a URL can carry: lower case letters, digits and dashes, up to sixty-four of them. */
const TEMPLATE_ID_PATTERN = /^[a-z0-9-]{1,64}$/;

export function sanitizeTemplateId(value: unknown): string | undefined {
  if (typeof value !== "string" || !TEMPLATE_ID_PATTERN.test(value)) return undefined;
  return value;
}

export interface SlateAgentActivity {
  readonly kind?: string;
  readonly tool?: string;
  readonly detail?: string;
  readonly target?: string;
  readonly callId?: string;
}

/** The fields that make two activities the same activity, in the order they are read. */
const ACTIVITY_FIELDS = ["kind", "tool", "detail", "target", "callId"] as const satisfies readonly (keyof SlateAgentActivity)[];

/**
 * Whether two readings of what an agent is doing are the same reading.
 *
 * A missing activity is the same as the same missing activity, and an activity is compared on every field it carries —
 * a new field is a difference, not something to miss.
 */
export function areAgentActivitiesEqual(left: SlateAgentActivity | null | undefined, right: SlateAgentActivity | null | undefined): boolean {
  if (left === right) return true;
  if (left == null || right == null) return false;
  return ACTIVITY_FIELDS.every((field) => left[field] === right[field]);
}

export const SLATE_DEFAULT_AGENT_NAME = "New Bot";

/** What the platform called a new agent before it had a name of its own: still recognised as "not named yet". */
export const LEGACY_SLATE_DEFAULT_AGENT_NAME = "New Agent";

const UNNAMED_AGENT_NAMES: ReadonlySet<string> = new Set([SLATE_DEFAULT_AGENT_NAME, LEGACY_SLATE_DEFAULT_AGENT_NAME]);

export function isSlateDefaultAgentName(name: string): boolean {
  return UNNAMED_AGENT_NAMES.has(name.trim());
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

/** Whether a failure is the one the platform raises when an account is holding as many agents as it may. */
export function isSlateAgentLimitError(error: unknown): boolean {
  return error instanceof Error && error.message === SLATE_AGENT_LIMIT_MESSAGE;
}
