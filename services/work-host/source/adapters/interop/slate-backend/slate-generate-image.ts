/**
 * Generating an image through the counterpart image service.
 *
 * What the caller gets back is either the picture — its bytes and what they are — or an error; a model the account may
 * not use is told apart from every other refusal, because it is the one a caller can do something about.
 */

import { AiService } from "../proto/generated/aiserver/v1/aiserver_connect.ts";
import { GenerateImageReferenceImage, RunGenerateImageRequest, type RunGenerateImageResponse } from "../proto/generated/aiserver/v1/aiserver_pb.ts";
import { createSlateBackendClient, type SlateInferenceOptions } from "./slate-backend-client.ts";

export class SlateGenerateImageError extends Error {}

/** The account is not allowed to use the model it asked for. */
export class SlateGenerateImageModelRestrictedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SlateGenerateImageModelRestrictedError";
  }
}

export interface GenerateImageReferenceImageInput {
  readonly data: string;
  readonly mimeType: string;
}

/** The one backend call this service makes; a caller may hand one in instead of building it. */
export interface GenerateImageClient {
  runGenerateImage(request: RunGenerateImageRequest): Promise<RunGenerateImageResponse>;
}

export interface SlateGenerateImageOptions extends Omit<SlateInferenceOptions, "backendUrl"> {
  readonly modelId: string;
  readonly maxMode?: boolean;
  readonly client?: GenerateImageClient;
}

export function createSlateImageGenerator(options: SlateGenerateImageOptions) {
  const client = options.client ?? createSlateBackendClient(AiService, options);
  return async (_context: unknown, description: string, referenceImages?: readonly GenerateImageReferenceImageInput[]) => {
    const response = await client.runGenerateImage(new RunGenerateImageRequest({
      description,
      referenceImages: (referenceImages ?? []).map((image) => new GenerateImageReferenceImage({ data: image.data, mimeType: image.mimeType })),
      modelId: options.modelId,
      maxMode: options.maxMode ?? false,
    }));
    switch (response.result.case) {
      case "success":
        return { imageData: response.result.value.imageData, mimeType: response.result.value.mimeType };
      case "error":
        // A model the account may not use is the one refusal worth telling apart.
        if (response.result.value.modelRestricted) throw new SlateGenerateImageModelRestrictedError(response.result.value.error);
        throw new SlateGenerateImageError(response.result.value.error);
      case undefined:
        throw new SlateGenerateImageError("Image generation returned no result.");
    }
  };
}
