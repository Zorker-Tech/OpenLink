/** Resolve provider-specific model identifiers into the host's video attachment capability. */
export function isVideoAttachmentModelId(modelId: string | undefined): boolean {
  return modelId?.toLowerCase().includes("gemini") ?? false;
}
