/**
 * How a finished subagent announces itself to the agent that spawned it.
 *
 * The notification is delivered inside the parent's text stream, so it needs a delimiter the parent
 * can recognize and a reminder that says what to do with it — a subagent's report is context for the
 * parent, not something the user asked for and not something to repeat back to them.
 */

/** The name the parent recognizes a finished subagent's notification by. */
export const META_PARENT_COMPLETION_TAG = "agent_notification";

/** The tag as the stream carries it: the name between angle brackets. */
const asTag = (name: string): string => `<${name}>`;

export const META_PARENT_COMPLETION_OPEN_TAG = asTag(META_PARENT_COMPLETION_TAG);

export const META_PARENT_COMPLETION_CLOSE_TAG = asTag(`/${META_PARENT_COMPLETION_TAG}`);

/** The lines of the reminder the parent is given after the notification. */
const SYSTEM_REMINDER_LINES = [
  "<system_reminder>",
  "Do not reiterate or repeat the contents of this agent notification to the user unless asked to do so.",
  "",
  "Follow your instructions for Handling subagent notifications.",
  "</system_reminder>",
];

export const META_PARENT_COMPLETION_SYSTEM_REMINDER = SYSTEM_REMINDER_LINES.join("\n");
