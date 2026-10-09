/**
 * Generating an image for an agent, and keeping it.
 *
 * The platform's own image model is asked for the picture, and what came back is written into the agent's media store
 * — an image the agent cannot be shown again is worse than no image, so a generator that answered but could not be
 * saved fails the call rather than answering with something that is not there.
 */

import { SLATE_DEFAULT_MODEL_ID } from "../../shared/agents/agent-model.ts";
import { createCursorGenerateImageService } from "../../shared/node/cursor-backend/cursor-generate-image.ts";

export class SlateGenerateImagePersistError extends Error {}

export interface GenerateImageAuth {
  readonly getAccessToken: () => Promise<string>;
  readonly getMachineId: () => Promise<string>;
}

export interface GeneratedImage {
  readonly imageData: string;
  readonly mimeType: string;
}

export interface PersistedImage {
  readonly absolutePath: string;
}

/** How the platform's own image generator is built; a caller may hand one in instead. */
export type GenerateImageFactory = (options: {
  readonly getAccessToken: () => Promise<string>;
  readonly getMachineId: () => Promise<string>;
  readonly modelId: string;
  readonly maxMode: boolean;
  readonly onRequestId?: (id: string) => void;
}) => ReturnType<typeof createCursorGenerateImageService>;

export interface GenerateImageServiceOptions {
  readonly persistImage: (bytes: Uint8Array, mimeType: string) => Promise<PersistedImage | null>;
  readonly onRequestId?: (id: string) => void;
  readonly generateImage?: GenerateImageFactory;
}

export function createSlateGenerateImageService<Context>(auth: GenerateImageAuth, options: GenerateImageServiceOptions) {
  const build = options.generateImage ?? createCursorGenerateImageService;
  const generateImage = build({
    getAccessToken: auth.getAccessToken,
    getMachineId: auth.getMachineId,
    // The turn's own model when there is one, and the platform's default otherwise.
    modelId: process.env.SLATE_AGENT_MODEL ?? SLATE_DEFAULT_MODEL_ID,
    maxMode: true,
    ...(options.onRequestId === undefined ? {} : { onRequestId: options.onRequestId }),
  });
  return async (ctx: Context, description: string, _filePath: string, referenceImages: readonly { data: string; mimeType: string }[]) => {
    const generated = await generateImage(ctx, description, referenceImages);
    const persisted = await options.persistImage(Buffer.from(generated.imageData, "base64"), generated.mimeType);
    if (persisted == null) throw new SlateGenerateImagePersistError("Failed to save the generated image into the agent's media store.");
    return { filePath: persisted.absolutePath, imageData: generated.imageData };
  };
}
