import { randomUUID } from "node:crypto";
import { SlateCloudAgentLaunchError } from "./cloud-agent-launch-error.ts";

export function buildCloudAgentRequestedModel(
  modelId?: string | null,
  params?: Readonly<Record<string, string>> | null,
) {
  const parameters = Object.entries(params ?? {}).map(([id, value]) => ({ id, value }));
  const selectedModel = modelId?.trim();
  if (!selectedModel) {
    if (parameters.length > 0) throw new SlateCloudAgentLaunchError("'model' is required when 'model_params' are provided.");
    return null;
  }
  return { modelId: selectedModel, maxMode: true, parameters };
}

export interface CloudAgentImageInput {
  readonly data: Uint8Array;
  readonly path?: string;
  readonly mimeType?: string;
}

export function buildCloudAgentUserMessage(args: {
  readonly prompt: string;
  readonly mode?: unknown;
  readonly images?: readonly CloudAgentImageInput[];
}) {
  const images = args.images ?? [];
  const selectedImages = images.map((image) => ({
    dataOrBlobId: { case: "data" as const, value: image.data },
    path: image.path ?? "",
    mimeType: image.mimeType ?? "",
  }));
  return {
    text: args.prompt,
    messageId: randomUUID(),
    ...(args.mode == null ? {} : { mode: args.mode }),
    ...(selectedImages.length === 0 ? {} : { selectedContext: { selectedImages } }),
  };
}

export function buildCloudAgentConversationAction(userMessage: ReturnType<typeof buildCloudAgentUserMessage>) {
  return { action: { case: "userMessageAction" as const, value: { userMessage, sendToInteractionListener: true } } };
}
