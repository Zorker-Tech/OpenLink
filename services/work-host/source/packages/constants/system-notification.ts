/** Markers that wrap a system notification in conversation text. */
const NOTIFICATION_TAG_NAME = "system_notification"
const OPENING_MARKER = "<"
const CLOSING_MARKER = "</"
const MARKER_END = ">"

export const SYSTEM_NOTIFICATION_TAG = NOTIFICATION_TAG_NAME
export const SYSTEM_NOTIFICATION_OPEN_TAG = `${OPENING_MARKER}${NOTIFICATION_TAG_NAME}${MARKER_END}`
export const SYSTEM_NOTIFICATION_CLOSE_TAG = `${CLOSING_MARKER}${NOTIFICATION_TAG_NAME}${MARKER_END}`
