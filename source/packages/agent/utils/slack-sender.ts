/**
 * Telling an agent who a channel message came from.
 *
 * A message that arrives from a chat integration is not from the user, and an agent that cannot tell
 * the difference will answer as if it were. The line names the sender — with the id when there is one,
 * since two people can share a display name — and the sender's kind when the platform knows it.
 */

export function formatSlackSenderLine(
  senderName?: string,
  senderId?: string,
  senderType?: string,
): string | undefined {
  const name = senderName?.trim()
  const id = senderId?.trim()
  const hasName = name !== undefined && name.length > 0
  const hasId = id !== undefined && id.length > 0
  if (!hasName && !hasId) return undefined

  const type = senderType?.trim()
  const typeSuffix = type !== undefined && type.length > 0 ? ` (${type})` : ""
  if (hasName && hasId) return `The current message is being sent by ${name} (${id})${typeSuffix}`
  return `The current message is being sent by ${hasName ? name : id}${typeSuffix}`
}
