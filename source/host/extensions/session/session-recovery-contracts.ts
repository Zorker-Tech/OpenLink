export interface ConversationBlobStore<Value> {
  getBlob(context: unknown, id: Uint8Array): Promise<Value | null>
  setBlob(context: unknown, id: Uint8Array, data: Value): Promise<void>
  flush(context: unknown): Promise<void>
}
