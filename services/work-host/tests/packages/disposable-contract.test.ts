import assert from "node:assert/strict"
import { test } from "node:test"

import { createContext, type Context } from "../../source/packages/context/context.ts"
import type { AgentConversationCodec } from "../../source/packages/agent-kv/agent-conversation-store-contracts.ts"
import { AgentConversationStore, getDefaultAgentMetadata, type AgentMetadataStore } from "../../source/packages/agent-kv/agent-conversation-store.ts"
import { InMemoryBlobStore } from "../../source/packages/agent-kv/blob-store.ts"
import type { BlobStore } from "../../source/packages/agent-kv/blob-store-contracts.ts"
import { Disposable } from "../../source/packages/utils/disposable.ts"

type Checkpoint = Record<string, never>
type Conversation = Record<string, never>

class ReleasableBlobStore extends Disposable implements BlobStore<Context> {
  private readonly store = new InMemoryBlobStore<Context>()
  disposeCalls = 0

  getBlob(context: Context, blobId: Uint8Array) { return this.store.getBlob(context, blobId) }
  setBlob(context: Context, blobId: Uint8Array, data: Uint8Array) { return this.store.setBlob(context, blobId, data) }
  setBlobLocallyOnly(context: Context, blobId: Uint8Array, data: Uint8Array) { return this.store.setBlobLocallyOnly(context, blobId, data) }
  flush(context: Context) { return this.store.flush(context) }

  dispose(): void {
    this.disposeCalls += 1
  }
}

class DuckTypedBlobStore extends InMemoryBlobStore<Context> {
  disposeCalls = 0
  dispose(): void { this.disposeCalls += 1 }
}

const codec: AgentConversationCodec<Context, Checkpoint, Conversation> = {
  createEmptyCheckpoint: () => ({}),
  encodeCheckpoint: () => new Uint8Array(),
  decodeCheckpoint: () => ({}),
  getLastRequestId: async () => null,
  hydrateConversation: async () => ({}),
  resolveSubconversations: async () => ({}),
}

function metadataStore(): AgentMetadataStore {
  const values = new Map<string, unknown>(Object.entries(getDefaultAgentMetadata("agent-disposable-test")))
  return {
    subscribe: () => () => {},
    set(key, value) { values.set(key, value); return value },
    get(key) { return values.get(key) as never },
  }
}

function conversation(blobStore: BlobStore<Context>): AgentConversationStore<Context, Checkpoint, Conversation> {
  return new AgentConversationStore(blobStore, metadataStore(), { codec })
}

test("the conversation owner releases blob stores that extend Slate Disposable", async () => {
  const blobStore = new ReleasableBlobStore()

  await conversation(blobStore).dispose()

  assert.equal(blobStore.disposeCalls, 1)
})

test("a store with a dispose-shaped method is not released without the marker base class", async () => {
  const blobStore = new DuckTypedBlobStore()

  await conversation(blobStore).dispose()

  assert.equal(blobStore.disposeCalls, 0)
  assert.equal(blobStore instanceof Disposable, false)
})
