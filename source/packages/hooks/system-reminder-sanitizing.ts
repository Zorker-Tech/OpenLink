/**
 * Keeping hook content from being mistaken for the platform's own instructions.
 *
 * The model is told things in `<system_reminder>` blocks, and a hook's added context is wrapped in one
 * of those blocks to reach it. A hook that writes that tag itself would otherwise be able to close the
 * block early and have its text read as platform policy, so every occurrence of the tag in hook content
 * is defused on the way in.
 */

const SYSTEM_REMINDER_TAG_PATTERN = /<(\/?)system_reminder>/gi

export const sanitizeSystemReminderContent = (content: string): string =>
  content.replace(SYSTEM_REMINDER_TAG_PATTERN, (_match, slash: string) => `<${slash}system_reminder_>`)
