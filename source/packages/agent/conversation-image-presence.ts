/**
 * Whether the conversation has ever contained an image, and how long it has been since one.
 *
 * A model that was given an image earlier in a conversation can keep reasoning about it, and a model that
 * has never been given one should not be asked to. So the question the platform asks is about the whole
 * conversation, and the useful answer includes how many user turns have passed since the last image —
 * which is what decides whether the earlier image is still within reach.
 *
 * The search walks the message structure rather than a fixed shape, because an image part sits at
 * different depths depending on the provider, and it is bounded so a deeply nested or self-referential
 * value cannot cost the turn its budget.
 */

function valueContainsImagePart(value: unknown, depth: number): boolean {
  if (depth > 6 || value === null || typeof value !== "object") return false
  if ("type" in value && value.type === "image") return true
  if (Array.isArray(value)) return value.some(item => valueContainsImagePart(item, depth + 1))
  return Object.values(value).some(nested =>
    nested !== null && typeof nested === "object" && valueContainsImagePart(nested, depth + 1))
}

export function coreMessageJsonHasImage(message: unknown): boolean {
  if (message === null || typeof message !== "object" || !("content" in message) || !Array.isArray(message.content)) {
    return false
  }
  return message.content.some(part => valueContainsImagePart(part, 0))
}

interface CoreMessageImagePresenceInput {
  readonly role?: unknown
  readonly content?: unknown
}

/** The newest image wins: the count is of user turns after it, not before. */
export function computeCoreMessageImagePresence(
  orderedMessages: readonly CoreMessageImagePresenceInput[],
): { containsImage: boolean; suffixNumberOfTurnsWithoutImages: number } {
  let suffixNumberOfTurnsWithoutImages = 0
  for (let index = orderedMessages.length - 1; index >= 0; index--) {
    const message = orderedMessages[index]!
    if (coreMessageJsonHasImage(message)) return { containsImage: true, suffixNumberOfTurnsWithoutImages }
    if (message.role === "user") suffixNumberOfTurnsWithoutImages++
  }
  return { containsImage: false, suffixNumberOfTurnsWithoutImages }
}
