import type { ConversationBlobStore } from "./session-recovery-contracts.ts"

function stableBlobKey(id: Uint8Array): string {
  return Buffer.from(id).toString("hex")
}

/** Shares in-flight reads by blob id and makes a pending write visible to later reads. */
export function memoizeConversationBlobs<Value>(store: ConversationBlobStore<Value>) {
  const settledOrPendingReads = new Map<string, Promise<Value | null>>()

  return {
    getBlob(context: unknown, id: Uint8Array): Promise<Value | null> {
      const key = stableBlobKey(id)
      const cached = settledOrPendingReads.get(key)
      if (cached !== undefined) return cached

      const request = store.getBlob(context, id)
      settledOrPendingReads.set(key, request)
      return request
    },
    setBlob(context: unknown, id: Uint8Array, data: Value): Promise<void> {
      settledOrPendingReads.set(stableBlobKey(id), Promise.resolve(data))
      return store.setBlob(context, id, data)
    },
    flush(context: unknown): Promise<void> {
      return store.flush(context)
    },
  }
}
