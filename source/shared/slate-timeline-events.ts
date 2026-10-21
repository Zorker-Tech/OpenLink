/**
 * What an agent's timeline shows.
 *
 * The timeline is the history of what happened to an agent, and each event says which of those it is: its name
 * changing, a channel being connected or disconnected, and the actions an automation took — with the verb each action
 * is said with.
 */

/** How an automation's action is said, in the past tense the timeline reads in. */
export const ACTION_VERB: Readonly<Record<string, string>> = {
  created: "Created",
  updated: "Updated",
  enabled: "Enabled",
  disabled: "Disabled",
  deleted: "Deleted",
};

export type TimelineEvent =
  | { readonly type: "name-changed"; readonly to: string }
  | { readonly type: "channel-connected"; readonly label: string }
  | { readonly type: "channel-disconnected"; readonly label: string }
  | {
      readonly type: "automation-changed";
      readonly action: string;
      readonly automationName: string;
    }
  | { readonly type: string; readonly [key: string]: unknown };

/**
 * What an event this build does not describe is said as.
 *
 * A timeline written by a newer version may hold an event with no wording here; it is read as the fallback the caller
 * gives, since saying nothing about it would lose the fact that something happened.
 */
export function unknownEventText(_event: unknown, fallback: string): string {
  return fallback;
}

/** The sentence a timeline shows for one event. */
type Describer = (event: Record<string, unknown>) => string;

/**
 * A table, not an object: an event's type is whatever the timeline wrote, and a name every object already has
 * (`toString`, `__proto__`) must not answer with a describer that was never written.
 */
const DESCRIBERS: ReadonlyMap<string, Describer> = new Map<string, Describer>([
  ["name-changed", (event) => `Renamed to ${String(event["to"])}`],
  ["channel-connected", (event) => `Connected to ${String(event["label"])}`],
  ["channel-disconnected", (event) => `Disconnected from ${String(event["label"])}`],
  ["automation-changed", (event) => `${ACTION_VERB[String(event["action"])] ?? "Changed"} automation "${String(event["automationName"])}"`],
]);

export function describeEvent(event: TimelineEvent): string {
  const describer = DESCRIBERS.get(event.type);
  if (describer !== undefined) return describer(event as Record<string, unknown>);
  return unknownEventText(event, "Updated this conversation");
}

/** What a wake prompt says first, so the model can tell a timeline event from the user typing. */
export const WAKE_CUE = "[event]";

/** The prompt a wake carries: what the cue means, one line per event, and what to do about it. */
export function buildTimelineEventWakePrompt(events: readonly TimelineEvent[]): string {
  const lines = events.map((event) => `- ${describeEvent(event)}`);
  return [
    `${WAKE_CUE} Something about this conversation just changed.`,
    "This is a system event recorded in your timeline, not the user typing in this app, and possibly something you did yourself.",
    ...lines,
    "If it is worth acknowledging to the user, reply with SendMessage; otherwise it is fine to stay silent.",
  ].join("\n");
}
