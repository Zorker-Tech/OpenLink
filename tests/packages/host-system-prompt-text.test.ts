import { test } from "node:test"
import assert from "node:assert/strict"

import {
  appendUserReplyReminder,
  buildAttachedFilesNote,
  buildReplyContextNote,
  buildSlateBaseSystemPrompt,
  buildSlateSubagentSystemPrompt,
  buildUserMessageAddressNote,
  DEFAULT_SLATE_SYSTEM_PROMPT,
  formatAttachedFileSize,
  isMediaReviewSubagentType,
  SLATE_MCP_MULTI_ACCOUNT_PROMPT_SECTION,
  SLATE_SUBAGENT_SAFETY_PROMPT_SECTION,
  SLATE_SYSTEM_PROMPT_CLOUD_AGENTS_DISABLED,
  USER_MESSAGE_REPLY_REMINDER,
} from "../../source/host/runner/system-prompt.ts"

test("a reply reminder is appended when a reply is expected, and can be switched off", () => {
  assert.equal(appendUserReplyReminder("hello", {}), "hello\n\n" + USER_MESSAGE_REPLY_REMINDER)
  assert.equal(appendUserReplyReminder("", {}), USER_MESSAGE_REPLY_REMINDER)
  assert.equal(appendUserReplyReminder("hello", { SLATE_DISABLE_USER_REPLY_REMINDER: "1" }), "hello")
  assert.equal(appendUserReplyReminder("hello", { SLATE_DISABLE_USER_REPLY_REMINDER: "true" }), "hello\n\n" + USER_MESSAGE_REPLY_REMINDER, "only the exact word switches it off")
})

test("a file size is said in the unit that reads it best", () => {
  assert.equal(formatAttachedFileSize(-1), "")
  assert.equal(formatAttachedFileSize(Number.NaN), "")
  assert.equal(formatAttachedFileSize(0), "0 B")
  assert.equal(formatAttachedFileSize(1_023), "1023 B")
  assert.equal(formatAttachedFileSize(1_024), "1.0 KB")
  assert.equal(formatAttachedFileSize(10_240), "10 KB")
  assert.equal(formatAttachedFileSize(1_048_576), "1.0 MB")
  assert.equal(formatAttachedFileSize(1_073_741_823), "1024.0 MB")
  assert.equal(formatAttachedFileSize(1_073_741_824), "1.0 GB")
})

test("the attached-files note says where the files are and which were staged", () => {
  const plain = buildAttachedFilesNote(["/a.png", " /b.jpg "])
  assert.match(plain, /^The user attached these files\. /)
  assert.match(plain, /they are not on your box/)
  assert.match(plain, /\n- \/a\.png\n- \/b\.jpg$/)
  const staged = buildAttachedFilesNote(["/a.png"], new Map([["/a.png", "/box/a.png"]]), new Map([["/a.png", 1_024]]))
  assert.match(staged, /^The user attached a file\. /)
  assert.match(staged, /also copied into your box at \/box\/a\.png/)
  assert.match(staged, /\(1\.0 KB\)/)
  assert.equal(buildAttachedFilesNote(["  "]), "")
  const mixed = buildAttachedFilesNote(["/a.png", "/b.jpg"], new Map([["/a.png", "/box/a.png"]]))
  assert.match(mixed, /the ones marked/, "one staged file is enough to explain the staging")
  assert.doesNotMatch(mixed, /not on your box/)
})

test("the reply context, the message address and the media reviewer are read from what they carry", () => {
  assert.equal(buildReplyContextNote({ targetId: "a", quote: "b" }), '[In reply to a: "b"]')
  assert.equal(buildReplyContextNote({ targetId: " a ", quote: " b " }), '[In reply to a: "b"]')
  assert.equal(buildReplyContextNote({ targetId: "", quote: "b" }), "")
  assert.equal(buildReplyContextNote({ targetId: "a" }), "")
  assert.equal(buildReplyContextNote(null), "")
  assert.equal(buildUserMessageAddressNote(" a "), "[a]")
  assert.equal(buildUserMessageAddressNote("  "), "")
  assert.equal(buildUserMessageAddressNote(), "")
  for (const type of ["watch_video", "watchVideo", "video-review", "VideoReview", "WATCH-VIDEO"]) assert.equal(isMediaReviewSubagentType(type), true, type)
  for (const type of [undefined, "", "review", "video reviewer"]) assert.equal(isMediaReviewSubagentType(type), false, String(type))
})

test("the prompts say who the model is, and what changes when cloud agents are off", () => {
  assert.equal(typeof SLATE_SUBAGENT_SAFETY_PROMPT_SECTION, "string")
  assert.match(SLATE_SUBAGENT_SAFETY_PROMPT_SECTION, /## Staying safe while you work/)
  assert.match(buildSlateSubagentSystemPrompt({ subagentType: "explore", readonly: true }), /running as the explore subagent/)
  assert.match(buildSlateSubagentSystemPrompt({ readonly: true }), /readonly mode/)
  assert.doesNotMatch(buildSlateSubagentSystemPrompt({ subagentType: "explore" }), /readonly mode/, "a writable subagent is not told it cannot write")
  assert.match(DEFAULT_SLATE_SYSTEM_PROMPT, /cloud agent/i)
  assert.match(SLATE_SYSTEM_PROMPT_CLOUD_AGENTS_DISABLED, /Cursor cloud agents are disabled/)
  assert.match(SLATE_SYSTEM_PROMPT_CLOUD_AGENTS_DISABLED, /cloud agent/i)
  assert.match(SLATE_MCP_MULTI_ACCOUNT_PROMPT_SECTION, /## MCP server accounts/)
  assert.match(buildSlateBaseSystemPrompt({ cloudAgentsEnabled: false }), /Cursor cloud agents are disabled/)
})
