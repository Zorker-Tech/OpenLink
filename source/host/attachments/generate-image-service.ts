/**
 * Generating an image for an agent, and keeping it.
 *
 * The platform's own image model is asked for the picture, and what came back is written into the agent's media store
 * — an image the agent cannot be shown again is worse than no image, so a generator that answered but could not be
 * saved fails the call rather than answering with something that is not there.
 */

import { SLATE_DEFAULT_MODEL_ID } from "../../shared/agents/agent-model.ts";
import { createSlateImageGenerator } from "../../adapters/interop/slate-backend/slate-generate-image.ts";

export class SlateGenerateImagePersistError extends Error {}

export interface GenerateImageAuth {
  readonly getAccessToken: () => Promise<string>;
  readonly getMachineId: () => Promise<string>;
}

export interface GeneratedImage {
  readonly imageData: string;
  readonly mimeType: string;
}

export interface GenerateImageReferenceImage {
  readonly data: string;
  readonly mimeType: string;
}

export interface PersistedImage {
  readonly absolutePath: string;
}

export interface GenerateImageFactoryOptions {
  readonly getAccessToken: () => Promise<string>;
  readonly getMachineId: () => Promise<string>;
  readonly modelId: string;
  readonly maxMode: boolean;
  readonly onRequestId?: (id: string) => void;
}

export type GenerateImageRunner = (
  context: unknown,
  description: string,
  referenceImages: readonly GenerateImageReferenceImage[],
) => Promise<GeneratedImage>;

/** Build the provider call through an adapter while keeping its result behind a Slate-owned contract. */
export type GenerateImageFactory = (options: GenerateImageFactoryOptions) => GenerateImageRunner;

export interface GenerateImageServiceOptions {
  readonly persistImage: (bytes: Uint8Array, mimeType: string) => Promise<PersistedImage | null>;
  readonly onRequestId?: (id: string) => void;
  readonly generateImage?: GenerateImageFactory;
}

export function createSlateGenerateImageService<Context>(auth: GenerateImageAuth, options: GenerateImageServiceOptions) {
  const buildGenerator = options.generateImage ?? createSlateImageGenerator;
  const generate = buildGenerator(generatorOptions(auth, options.onRequestId));
  return (context: Context, description: string, _filePath: string, referenceImages: readonly GenerateImageReferenceImage[]) =>
    generateAndPersistImage(context, description, referenceImages, generate, options.persistImage);
}

function generatorOptions(auth: GenerateImageAuth, onRequestId?: (id: string) => void): GenerateImageFactoryOptions {
  return {
    getAccessToken: auth.getAccessToken,
    getMachineId: auth.getMachineId,
    modelId: process.env.SLATE_AGENT_MODEL ?? SLATE_DEFAULT_MODEL_ID,
    maxMode: true,
    ...(onRequestId === undefined ? {} : { onRequestId }),
  };
}

async function generateAndPersistImage(
  context: unknown,
  description: string,
  referenceImages: readonly GenerateImageReferenceImage[],
  generate: GenerateImageRunner,
  persist: GenerateImageServiceOptions["persistImage"],
): Promise<{ readonly filePath: string; readonly imageData: string }> {
  const image = await generate(context, description, referenceImages);
  const saved = await persist(Buffer.from(image.imageData, "base64"), image.mimeType);
  if (saved == null) {
    throw new SlateGenerateImagePersistError("Failed to save the generated image into the agent's media store.");
  }
  return { filePath: saved.absolutePath, imageData: image.imageData };
}
