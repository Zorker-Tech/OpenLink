/**
 * How a finished subagent announces itself to the agent that spawned it.
 *
 * The notification is delivered inside the parent's text stream, so it needs a delimiter the parent
 * can recognize and a reminder that says what to do with it — a subagent's report is context for the
 * parent, not something the user asked for and not something to repeat back to them.
 */

export const META_PARENT_COMPLETION_TAG = "agent_notification"
export const META_PARENT_COMPLETION_OPEN_TAG = `<${META_PARENT_COMPLETION_TAG}>`
export const META_PARENT_COMPLETION_CLOSE_TAG = `</${META_PARENT_COMPLETION_TAG}>`

export const META_PARENT_COMPLETION_SYSTEM_REMINDER = `<system_reminder>
Do not reiterate or repeat the contents of this agent notification to the user unless asked to do so.

Follow your instructions for Handling subagent notifications.
</system_reminder>`
