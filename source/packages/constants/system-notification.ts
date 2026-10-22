/**
 * The tags a system notification is wrapped in.
 *
 * A notification is delivered inside the conversation's text stream, so it needs a delimiter that cannot be confused
 * with the user's or the model's own words — and one the renderer can find without parsing the text around it.
 */

/** The tag name a notification carries, without its brackets. */
export const SYSTEM_NOTIFICATION_TAG = "system_notification"

/** The opening tag: the tag name in brackets. */
export const SYSTEM_NOTIFICATION_OPEN_TAG = `<${SYSTEM_NOTIFICATION_TAG}>`

/** The closing tag: the tag name in brackets, with the closing slash. */
export const SYSTEM_NOTIFICATION_CLOSE_TAG = `</${SYSTEM_NOTIFICATION_TAG}>`
