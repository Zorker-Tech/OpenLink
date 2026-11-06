import assert from "node:assert/strict"
import { test } from "node:test"

import { InMemoryBlobStore } from "../../source/packages/agent-kv/blob-store.ts"
import { ObservedBlobStore } from "../../source/packages/agent-kv/typed-blob-store.ts"
import { createContext } from "../../source/packages/context/context.ts"
import { persistPromptContextUsageSnapshot } from "../../source/packages/agent/utils/usage-snapshot.ts"
import { PrivacyMode } from "../../source/packages/redaction/privacy-mode.ts"

test("usage snapshots report their wire type through the store metadata port", async () => {
  const context = createContext()
  const observations: unknown[] = []
  const blobStore = new ObservedBlobStore(new InMemoryBlobStore(), value => observations.push(value))
  const id = await persistPromptContextUsageSnapshot({
    blobStore,
    ctx: context,
    privacyMode: PrivacyMode.USAGE_DATA_TRAINING_ALLOWED,
    rootPromptMessagesJson: [new Uint8Array([1, 2, 3])],
    usageTree: {
      schemaVersion: 1,
      nodes: [],
    },
  })

  assert.ok(id)
  assert.equal(observations.length, 1)
  assert.deepEqual(observations[0], {
    blobId: id,
    blobType: { kind: "proto", typeName: "agent.v1.PromptContextUsageSnapshot" },
  })
})
