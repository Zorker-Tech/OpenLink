/**
 * The tags a system notification is wrapped in.
 *
 * A notification is delivered inside the conversation's text stream, so it needs a delimiter that
 * cannot be confused with the user's or the model's own words — and one the renderer can find without
 * parsing the text around it.
 */

export const SYSTEM_NOTIFICATION_TAG = "system_notification"
export const SYSTEM_NOTIFICATION_OPEN_TAG = `<${SYSTEM_NOTIFICATION_TAG}>`
export const SYSTEM_NOTIFICATION_CLOSE_TAG = `</${SYSTEM_NOTIFICATION_TAG}>`
