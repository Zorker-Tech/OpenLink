/**
 * Whether the conversation has ever contained an image, and how long it has been since one.
 *
 * A model that was given an image earlier in a conversation can keep reasoning about it, and a model that has
 * never been given one should not be asked to. So the question the platform asks is about the whole conversation,
 * and the useful answer includes how many user turns have passed since the last image — which is what decides
 * whether the earlier image is still within reach.
 *
 * The search walks the message structure rather than a fixed shape, because an image part sits at different
 * depths depending on the provider, and it is bounded so a deeply nested or self-referential value cannot cost
 * the turn its budget.
 */

/** The part type that marks an image, whatever shape a provider wraps around it. */
const IMAGE_PART_TYPE = "image";

/** The role a turn from the person carries; only those turns are counted after the newest image. */
const USER_ROLE = "user";

/** How many levels of nesting a search follows, so a self-referential part cannot cost the turn its budget. */
const SEARCH_DEPTH_LIMIT = 6;

type JsonRecord = Record<string, unknown>;

function isJsonRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object";
}

/** Whether this value says it is an image part, rather than something that holds one. */
function isImagePart(value: JsonRecord): boolean {
  return "type" in value && value.type === IMAGE_PART_TYPE;
}

/** The values a search descends into: an array's items, or an object's own values. */
function childValues(value: JsonRecord): readonly unknown[] {
  return Array.isArray(value) ? value : Object.values(value);
}

function subtreeHasImage(value: unknown, level: number): boolean {
  if (!isJsonRecord(value) || level > SEARCH_DEPTH_LIMIT) return false;
  if (isImagePart(value)) return true;
  return childValues(value).some(child => subtreeHasImage(child, level + 1));
}

/** Whether a message's content array holds an image anywhere the search follows. */
export function coreMessageJsonHasImage(message: unknown): boolean {
  if (!isJsonRecord(message) || !("content" in message) || !Array.isArray(message.content)) return false;
  return message.content.some(part => subtreeHasImage(part, 0));
}

interface ConversationMessage {
  readonly role?: unknown;
  readonly content?: unknown;
}

interface ImagePresence {
  containsImage: boolean;
  suffixNumberOfTurnsWithoutImages: number;
}

/** The newest image wins: the count is of user turns after it, not before. */
export function computeCoreMessageImagePresence(
  orderedMessages: readonly ConversationMessage[],
): ImagePresence {
  let turnsSinceNewestImage = 0;
  for (let cursor = orderedMessages.length - 1; cursor >= 0; cursor--) {
    const current = orderedMessages[cursor]!;
    if (coreMessageJsonHasImage(current)) return { containsImage: true, suffixNumberOfTurnsWithoutImages: turnsSinceNewestImage };
    if (current.role === USER_ROLE) turnsSinceNewestImage++;
  }
  return { containsImage: false, suffixNumberOfTurnsWithoutImages: turnsSinceNewestImage };
}
