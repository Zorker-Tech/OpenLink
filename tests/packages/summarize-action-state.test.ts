import { test } from "node:test"
import assert from "node:assert/strict"

import { applySummaryToConversation } from "../../source/packages/agent/actions/summarize-action-state.ts"
import { createContext } from "../../source/packages/context/context.ts"
import { DataClassification, PrivacyCapability } from "../../source/packages/redaction/classification.ts"
import { createRedactedString } from "../../source/packages/redaction/create.ts"
import { PrivacyMode } from "../../source/packages/redaction/privacy-mode.ts"
import type { SlateConversationState } from "../../source/packages/agent/conversation-state.ts"

test("summary action stores Slate text and emits the same privacy-aware summary update", async () => {
  const context = createContext()
  const stored: unknown[] = []
  const updates: unknown[] = []
  const summary = createRedactedString("compressed text", DataClassification.CODE, "summary", PrivacyMode.NO_STORAGE)
  const nextState: SlateConversationState = {
    privacyMode: PrivacyMode.NO_STORAGE,
    rootPromptMessagesJson: [],
    turns: [],
    todos: [],
    previousWorkspaceUris: [],
    summaryArchives: [],
    fileStatesV2: new Map(),
    readPaths: [],
  }
  const state = {
    tokenDetails: { usedTokens: 0, maximumTokens: 100 },
    getBlobStore: () => undefined,
    getPrivacyMode: () => PrivacyMode.NO_STORAGE,
    computeNewStructure: async () => nextState,
    setSummary: (value: unknown) => stored.push(value),
    clearTurns: async () => {},
    setTokenDetails: () => {},
  }
  const prompt = { getMessages: () => [], appendMessages: () => {} }
  const listener = { async sendUpdate(_context: unknown, update: unknown) { updates.push(update) } }

  await applySummaryToConversation({
    context,
    summary,
    state,
    prompt,
    listener,
    clearTurns: false,
    privacyMode: PrivacyMode.NO_STORAGE,
  })

  assert.deepEqual(stored, [{ content: "compressed text" }])
  const update = updates[0] as {
    readonly message: { readonly case: string; readonly value: { readonly summary: { unwrap(capability: PrivacyCapability): string } } }
  }
  assert.equal(update.message.case, "summary")
  assert.equal(update.message.value.summary.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED), "compressed text")
})
