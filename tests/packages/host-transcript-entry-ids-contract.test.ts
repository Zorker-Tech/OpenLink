import assert from "node:assert/strict"
import { test } from "node:test"

import {
  INITIAL_TRANSCRIPT_TURN_KEY,
  countTrailingAssistantMessageEntries,
  countTrailingSendMessageEntries,
  countTrailingUserAttachmentEntries,
  countUserTranscriptEntries,
  firstUnoccupiedEntryId,
  allocateTranscriptEntryId,
} from "../../source/host/transcript/transcript-entry-ids.ts"

const entry = (id: string, kind: string, role?: string) => ({ id, kind, ...(role === undefined ? {} : { role }) })

test("transcript ids use the active user turn and count each entry family from its own suffix", () => {
  const history = [
    entry("t0u", "message", "user"),
    entry("t0ua0", "user-attachment"),
    entry("t0ua1", "user-attachment"),
    entry("t0a0", "message", "assistant"),
    entry("t0s0", "send-message"),
    entry("tool-1", "tool-call"),
  ]

  assert.equal(INITIAL_TRANSCRIPT_TURN_KEY, "b")
  assert.equal(countUserTranscriptEntries(history), 1)
  assert.equal(countTrailingUserAttachmentEntries(history), 2)
  assert.equal(countTrailingAssistantMessageEntries(history), 1)
  assert.equal(countTrailingSendMessageEntries(history), 1)
  assert.equal(allocateTranscriptEntryId(history, "user-message"), "t1u")
  assert.equal(allocateTranscriptEntryId(history, "user-attachment"), "t1ua2")
  assert.equal(allocateTranscriptEntryId(history, "assistant-message"), "t0a1")
  assert.equal(allocateTranscriptEntryId(history, "send-message"), "t0s1")
})

test("a later user message advances the turn and restarts trailing counters", () => {
  const history = [
    entry("t0u", "message", "user"),
    entry("t0a0", "message", "assistant"),
    entry("t0s0", "send-message"),
    entry("t1u", "message", "user"),
  ]

  assert.equal(countUserTranscriptEntries(history), 2)
  assert.equal(countTrailingAssistantMessageEntries(history), 0)
  assert.equal(countTrailingSendMessageEntries(history), 0)
  assert.equal(countTrailingUserAttachmentEntries(history), 0)
  assert.equal(allocateTranscriptEntryId(history, "assistant-message"), "t1a0")
  assert.equal(allocateTranscriptEntryId(history, "send-message"), "t1s0")
  assert.equal(allocateTranscriptEntryId(history, "user-attachment"), "t2ua0")
})

test("existing collisions advance the candidate until an unused id is found", () => {
  assert.equal(firstUnoccupiedEntryId(new Set(["t0u", "t1u", "t2u"]), (index) => `t${index}u`, 0), "t3u")
  assert.equal(allocateTranscriptEntryId([entry("tba0", "message", "assistant"), entry("tba1", "message", "assistant")] as never, "assistant-message"), "tba2")
})
