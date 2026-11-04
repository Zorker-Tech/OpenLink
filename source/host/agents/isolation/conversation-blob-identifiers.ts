/** The content identifier text a blob row stores for a binary digest. */
export function conversationBlobHexId(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("hex");
}
