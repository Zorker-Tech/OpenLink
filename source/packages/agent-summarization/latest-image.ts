/**
 * The last image in a conversation, found for a summary that has to carry it.
 *
 * An image is the one attachment a text summary cannot reproduce, and a conversation that was about an image
 * loses the thing it was about when it is compacted. So the most recent one is found and carried into the
 * summary beside the text — from a user message's own parts, or from the experimental content a tool result
 * may carry, since a tool that produced an image is the other place one appears.
 *
 * A user part's image is handed over as a data URL when it is bare base64, because that is the form a model
 * call takes, and left alone when it is already a URL of some kind — a remote image or a blob must not be
 * prefixed into nonsense. A missing mime type is assumed to be PNG, which is what an unlabelled image almost
 * always is.
 */

export interface SummarizationImagePart {
  readonly image: unknown;
  readonly mimeType?: unknown;
}

export interface SummarizationToolExperimentalImage {
  readonly type?: unknown;
  readonly data?: unknown;
  readonly mimeType?: unknown;
}

export interface SummarizationMessagePart {
  readonly type?: unknown;
  readonly image?: unknown;
  readonly mimeType?: unknown;
  readonly experimental_content?: readonly SummarizationToolExperimentalImage[] | undefined;
}

export interface SummarizationImageMessage {
  readonly role: string;
  readonly content: string | readonly SummarizationMessagePart[];
}

/** What an image is taken to be when nothing says otherwise. */
const ASSUMED_MIME_TYPE = "image/png";

/** An image that already points somewhere — at a data URL, a remote host or a blob — is not base64 to wrap. */
const ALREADY_A_REFERENCE = /^(data:|https?:|blob:)/i;

/** The mime type to name, trimmed, or the one an unlabelled image is assumed to have. */
function namedMimeType(mimeType: unknown): string {
  const trimmed = (mimeType as string | null | undefined)?.trim();
  return trimmed !== undefined && trimmed !== "" ? trimmed : ASSUMED_MIME_TYPE;
}

/** A part carries its mime type only when the caller gave one at all, whatever it was. */
function imagePart(image: unknown, mimeType: unknown): SummarizationImagePart {
  return mimeType === undefined ? { image } : { image, mimeType };
}

/** The last image among a tool result's experimental parts, as the data it happened to carry. */
function latestToolImage(parts: readonly SummarizationMessagePart[]): SummarizationImagePart | null {
  for (let partIndex = parts.length - 1; partIndex >= 0; partIndex -= 1) {
    const carried = parts[partIndex]?.experimental_content;
    if (carried === undefined) continue;
    for (let itemIndex = carried.length - 1; itemIndex >= 0; itemIndex -= 1) {
      const item = carried[itemIndex];
      if (item?.type === "image" && typeof item.data === "string") {
        return imagePart(item.data, typeof item.mimeType === "string" ? item.mimeType : undefined);
      }
    }
  }
  return null;
}

/** The last image a user wrote, as the part it was written in. */
function latestUserImage(parts: readonly SummarizationMessagePart[]): SummarizationImagePart | null {
  for (let partIndex = parts.length - 1; partIndex >= 0; partIndex -= 1) {
    const part = parts[partIndex];
    if (part?.type === "image") return imagePart(part.image, part.mimeType);
  }
  return null;
}

/** An image a message holds, whether it came from the user or from a tool the user's turn ran. */
function imageIn(message: SummarizationImageMessage): SummarizationImagePart | null {
  const parts = message.content as readonly SummarizationMessagePart[];
  if (message.role === "tool") return latestToolImage(parts);
  if (message.role === "user" && Array.isArray(message.content)) return latestUserImage(message.content);
  return null;
}

export function toUserMessageImagePart(part: SummarizationImagePart): {
  type: "image";
  image: unknown;
  mimeType?: unknown;
} {
  const image =
    typeof part.image === "string"
      ? ALREADY_A_REFERENCE.test(part.image)
        ? part.image
        : `data:${namedMimeType(part.mimeType)};base64,${part.image}`
      : part.image;
  return { type: "image", ...imagePart(image, part.mimeType) };
}

/** The newest image in the conversation, or nothing when it holds none. */
export function findLatestImagePart(messages: readonly SummarizationImageMessage[]): SummarizationImagePart | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const found = imageIn(messages[index]!);
    if (found !== null) return found;
  }
  return null;
}
