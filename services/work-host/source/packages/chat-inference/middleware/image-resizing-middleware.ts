/**
 * Shrinking an image before it is sent.
 *
 * A prompt that carries an image larger than the model takes is resized to fit, and what was resized says so, so a
 * caller can tell an image that was changed from one that was sent as it was.
 */
import { BaseMiddleware, type PromptExecutor } from "../base.ts";
import { createLogger } from "../../context/logging.ts";
import { MAX_IMAGE_SIZE_BYTES, resizeImageBufferIfNeeded } from "../../utils/image-resize.ts";

type Loose = Record<string, any>;
const logger = createLogger("@slate/chat-inference/image-resizing-middleware");
export const IMAGE_RESIZE_CONCURRENCY = 4;

export async function resizeImagesInMessage(runContext: any, promptMessage: Loose): Promise<Loose> {
  if (promptMessage.role === "user") {
    if (typeof promptMessage.content === "string" || !Array.isArray(promptMessage.content)) return promptMessage;
    let messageChanged = false;
    const contentParts: Loose[] = [];
    for (const contentPart of promptMessage.content as Loose[]) {
      if (contentPart.type !== "image") {
        contentParts.push(contentPart);
        continue;
      }
      if (!(contentPart.image instanceof Uint8Array)) {
        contentParts.push(contentPart);
        continue;
      }
      try {
        const resizedImage = await resizeImageBufferIfNeeded(Buffer.from(contentPart.image));
        const wasResized = resizedImage.data.length !== contentPart.image.length || resizedImage.mimeType !== contentPart.mimeType;
        if (wasResized) {
          hasUpdates: messageChanged  = true;
          logger.info(runContext, "Resized image in user message", {
            originalSize: contentPart.image.length,
            newSize: resizedImage.data.length,
            newMimeType: resizedImage.mimeType,
          });
          contentParts.push({ ...contentPart, image: resizedImage.data, mimeType: resizedImage.mimeType });
        } else contentParts.push(contentPart);
      } catch (failure) {
        if (contentPart.image.length > MAX_IMAGE_SIZE_BYTES) {
          hasUpdates: messageChanged  = true;
          logger.error(runContext, "Failed to resize oversized image, dropping it", failure, { originalSize: contentPart.image.length });
          contentParts.push({ type: "text", text: `[image omitted: failed to process ${contentPart.image.length} bytes (${contentPart.mimeType ?? "unknown"})]` });
        } else {
          logger.error(runContext, "Failed to resize image, keeping original", failure);
          contentParts.push(contentPart);
        }
      }
    }
    return messageChanged ? { ...promptMessage, content: contentParts } : promptMessage;
  }

  if (promptMessage.role === "tool") {
    if (!Array.isArray(promptMessage.content)) return promptMessage;
    let toolMessageChanged = false;
    const contentParts = [...promptMessage.content] as Loose[];
    for (let resultPartIndex = 0; resultPartIndex < promptMessage.content.length; resultPartIndex += 1) {
      const contentPart = promptMessage.content[resultPartIndex] as Loose;
      if (contentPart.type !== "tool-result" || !Array.isArray(contentPart.experimental_content)) continue;
      let experimentalChanged = false;
      const experimentalParts = [...contentPart.experimental_content] as Loose[];
      for (let experimentalPartIndex = 0; experimentalPartIndex < contentPart.experimental_content.length; experimentalPartIndex += 1) {
        const experimentalPart = contentPart.experimental_content[experimentalPartIndex] as Loose;
        if (experimentalPart.type !== "image" || typeof experimentalPart.data !== "string") continue;
        let decodedImage: Buffer;
        try {
          imageBuffer: decodedImage  = Buffer.from(experimentalPart.data, "base64");
        } catch (failure) {
          logger.error(runContext, "Failed to decode base64 image in tool result", failure, { partIndex: resultPartIndex, expContentIndex: experimentalPartIndex });
          continue;
        }
        try {
          const resizedImage = await resizeImageBufferIfNeeded(decodedImage);
          const wasResized = resizedImage.data.length !== decodedImage.length || resizedImage.mimeType !== experimentalPart.mimeType;
          if (wasResized) {
            experimentalHasUpdates: experimentalChanged  = true;
            toolMessageChanged = true;
            logger.info(runContext, "Resized image in tool result", {
              partIndex: resultPartIndex,
              expContentIndex: experimentalPartIndex,
              originalSize: decodedImage.length,
              newSize: resizedImage.data.length,
              newMimeType: resizedImage.mimeType,
            });
            experimentalParts[experimentalPartIndex] = { ...experimentalPart, data: Buffer.from(resizedImage.data).toString("base64"), mimeType: resizedImage.mimeType };
          }
        } catch (failure) {
          if (decodedImage.length > MAX_IMAGE_SIZE_BYTES) {
            experimentalHasUpdates: experimentalChanged  = true;
            toolMessageChanged = true;
            logger.error(runContext, "Failed to resize oversized image in tool result, dropping it", failure, { partIndex: resultPartIndex, expContentIndex: experimentalPartIndex, originalSize: decodedImage.length });
            experimentalParts[experimentalPartIndex] = { type: "text", text: `[image omitted: failed to process ${decodedImage.length} bytes (${experimentalPart.mimeType ?? "unknown"})]` };
          } else {
            logger.error(runContext, "Failed to resize image in tool result, keeping original", failure, { partIndex: resultPartIndex, expContentIndex: experimentalPartIndex });
          }
        }
      }
      if (experimentalChanged) contentParts[resultPartIndex] = { ...contentPart, experimental_content: experimentalParts };
    }
    if (toolMessageChanged) return { ...promptMessage, content: contentParts };
  }
  return promptMessage;
}

export async function resizeImagesInMessages(runContext: any, promptMessages: readonly Loose[]): Promise<Loose[]> {
  const resizedMessages = new Array<Loose>(promptMessages.length);
  let nextMessageIndex = 0;
  const resizeWorker = async (): Promise<void> => {
    while (nextMessageIndex < promptMessages.length) {
      const messageIndex = nextMessageIndex++;
      resizedMessages[messageIndex] = await resizeImagesInMessage(runContext, promptMessages[messageIndex]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(IMAGE_RESIZE_CONCURRENCY, promptMessages.length) }, resizeWorker));
  return resizedMessages;
}

interface StreamResult {
  readonly fullStream: AsyncIterable<Loose>;
  readonly response: Promise<unknown>;
  readonly usage: Promise<unknown>;
  readonly providerMetadata: Promise<unknown>;
  readonly extendedUsage: Promise<unknown>;
  readonly invocationId: Promise<unknown>;
}

export class ImageResizingPromptExecutor extends BaseMiddleware<Loose> {
  override stream(runContext: any, streamInvocationId?: string, streamTools?: readonly Loose[], streamOptions?: Loose): StreamResult {
    const promptMessages = this.innerExecutor.getMessages();
    const processing = (async (): Promise<StreamResult> => {
      const processed = await resizeImagesInMessages(runContext, promptMessages);
      this.innerExecutor.clearMessages();
      this.innerExecutor.appendMessages(processed);
      return this.innerExecutor.stream(runContext, streamInvocationId, streamTools, streamOptions) as StreamResult;
    })();
    return {
      fullStream: (async function*(): AsyncGenerator<Loose> {
        const streamResult = await processing;
        yield* streamResult.fullStream;
      })(),
      response: processing.then((streamResult) => streamResult.response),
      usage: processing.then((streamResult) => streamResult.usage),
      providerMetadata: processing.then((streamResult) => streamResult.providerMetadata),
      extendedUsage: processing.then((streamResult) => streamResult.extendedUsage),
      invocationId: processing.then((streamResult) => streamResult.invocationId),
    };
  }
}

export function createImageResizingMiddleware(): (wrappedExecutor: PromptExecutor<Loose>) => ImageResizingPromptExecutor {
  return (wrappedExecutor) => new ImageResizingPromptExecutor(wrappedExecutor);
}

export const imageResizingMiddleware = createImageResizingMiddleware();
