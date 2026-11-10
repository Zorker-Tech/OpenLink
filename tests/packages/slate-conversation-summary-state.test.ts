import { test } from "node:test"
import assert from "node:assert/strict"

import {
  createSlateConversationSummaryArchiveSerde,
  createSlateConversationSummarySerde,
  deserializeSlateConversationSummaryArchiveInterop,
  deserializeSlateConversationSummaryInterop,
  redactSlateConversationSummaryArchive,
  redactSlateConversationSummary,
} from "../../source/adapters/interop/agent/conversation-summary-storage-adapter.ts"
import { DataClassification, PrivacyCapability } from "../../source/packages/redaction/classification.ts"
import { PrivacyMode } from "../../source/packages/redaction/privacy-mode.ts"

test("new summary blobs use Slate fields and reapply privacy policy on read", () => {
  const serde = createSlateConversationSummarySerde(PrivacyMode.NO_STORAGE)
  const bytes = serde.serialize(redactSlateConversationSummary({ content: "summary content" }, PrivacyMode.NO_STORAGE))
  const json = new TextDecoder().decode(bytes)
  assert.ok(json.startsWith("SLATE-AGENT-SUMMARY\n"))
  assert.deepEqual(serde.getBlobType?.(), { kind: "json", typeName: "slate.agent-conversation-summary" })

  const stored = JSON.parse(json.slice("SLATE-AGENT-SUMMARY\n".length)) as {
    readonly format: string
    readonly summary: { readonly content: string }
  }
  assert.equal(stored.format, "slate.agent-conversation-summary")
  assert.equal(stored.summary.content, "summary content")
  const loaded = serde.deserialize(bytes)
  if (typeof loaded.content === "string") assert.fail("expected privacy-aware summary content")
  assert.equal(loaded.content.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED), "summary content")
  assert.equal(loaded.content.__classification, DataClassification.CODE)
  assert.equal(deserializeSlateConversationSummaryInterop(bytes).summary, "summary content")
})

test("summary archives persist Slate references and retain historical blob ids", () => {
  const archive = {
    summarizedMessageBlobIds: [new Uint8Array([1, 2]), new Uint8Array([3])],
    summary: "the compacted section",
    summaryMessageBlobId: new Uint8Array([4, 5]),
    unsummarizedWindowTail: 7,
  }
  const serde = createSlateConversationSummaryArchiveSerde(PrivacyMode.NO_STORAGE)
  const bytes = serde.serialize(redactSlateConversationSummaryArchive(archive, PrivacyMode.NO_STORAGE))
  assert.ok(new TextDecoder().decode(bytes).startsWith("SLATE-AGENT-SUMMARY-ARCHIVE\n"))
  const loaded = serde.deserialize(bytes)
  assert.deepEqual(loaded.summarizedMessageBlobIds, archive.summarizedMessageBlobIds)
  assert.deepEqual(loaded.summaryMessageBlobId, archive.summaryMessageBlobId)
  assert.equal(loaded.unsummarizedWindowTail, 7)
  if (typeof loaded.summary === "string") assert.fail("expected privacy-aware archived summary")
  assert.equal(loaded.summary.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED), archive.summary)
  const projected = deserializeSlateConversationSummaryArchiveInterop(bytes)
  assert.deepEqual(projected.summarizedMessages, archive.summarizedMessageBlobIds)
  assert.deepEqual(projected.summaryMessage, archive.summaryMessageBlobId)
})


