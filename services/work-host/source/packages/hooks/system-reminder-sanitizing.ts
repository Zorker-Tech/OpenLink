/**
 * Keeping hook content from being mistaken for the platform's own instructions.
 *
 * The model is told things in `<system_reminder>` blocks, and a hook's added context is wrapped in one of those blocks
 * to reach it. A hook that writes that tag itself would otherwise be able to close the block early and have its text
 * read as platform policy, so every occurrence of the tag in hook content is defused on the way in.
 */

/** The tag the platform wraps its own reminders in. */
const SYSTEM_REMINDER_TAG = "system_reminder"

/** A reminder tag as it may arrive: opening or closing, in any case. */
const SYSTEM_REMINDER_TAG_PATTERN = new RegExp(`<(/?)${SYSTEM_REMINDER_TAG}>`, "gi")

/** The same tag with an underscore on its name: still readable, no longer the tag. */
const defuseSystemReminderTag = (closingSlash: string): string => `<${closingSlash}${SYSTEM_REMINDER_TAG}_>`

/** Hook content with every reminder tag defused, so it can neither open nor close a reminder block. */
export const sanitizeSystemReminderContent = (content: string): string =>
  content.replace(SYSTEM_REMINDER_TAG_PATTERN, (_match, closingSlash: string) => defuseSystemReminderTag(closingSlash))
