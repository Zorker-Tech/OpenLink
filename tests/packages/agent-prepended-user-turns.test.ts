import { test } from "node:test"
import assert from "node:assert/strict"

import {
  appendPrependedUserTurns,
  selectRecentPrependedMessages,
} from "../../source/packages/agent/actions/user-message-action/prepended-user-turns.ts"

test("the prepend window keeps only the newest entries in their original order", () => {
  assert.deepEqual(selectRecentPrependedMessages(["a", "b", "c", "d"], 2), {
    retained: ["c", "d"],
    omittedCount: 2,
  })
  assert.deepEqual(selectRecentPrependedMessages(["a", "b"], 0), {
    retained: [],
    omittedCount: 2,
  })
  assert.deepEqual(selectRecentPrependedMessages(["a", "b"], -3), {
    retained: [],
    omittedCount: 2,
  })
})

test("the action skips already-recorded IDs and publishes only turns it will append", async () => {
  const events: string[] = []
  const result = await appendPrependedUserTurns({
    context: "ctx",
    enabled: true,
    incoming: [
      { id: "old", text: "discarded by the cap" },
      { id: "seen", text: "already present" },
      { id: "new", text: "append me" },
    ],
    maximum: 2,
    reminder: "session reminder",
    turnOptions: { dynamicToolCount: 4 },
    logger: {
      warn: (event, fields) => events.push(`${event}:${fields.droppedCount}`),
      info: (event, fields) => events.push(`${event}:${String(fields.prependUserMessagesCount ?? fields.prependedMessageId ?? "")}`),
    },
    decode: (message) => ({ messageId: message.id, text: message.text }),
    messageIdOf: (message) => message.messageId,
    existingMessageIds: async (context) => {
      assert.equal(context, "ctx")
      events.push("read-existing")
      return new Set(["seen"])
    },
    publish: async (_context, message) => {
      events.push(`publish:${message.id}`)
    },
    createTurn: async (context, message, options) => {
      assert.equal(context, "ctx")
      events.push(`turn:${message.messageId}:${options.additionalUserTurnSystemReminder}:${options.dynamicToolCount}`)
    },
  })

  assert.deepEqual(result, { candidateCount: 2, omittedCount: 1, createdCount: 1 })
  assert.deepEqual(events, [
    "dropped excess prepended user messages:1",
    "prepending user messages:2",
    "read-existing",
    "skipping duplicate prepended user message:seen",
    "publish:new",
    "turn:new:session reminder:4",
  ])
})

test("an empty message ID is not treated as a duplicate", async () => {
  const appended: string[] = []
  const result = await appendPrependedUserTurns({
    context: undefined,
    enabled: true,
    incoming: [{ id: "", text: "without identity" }],
    maximum: 1,
    reminder: undefined,
    turnOptions: {},
    logger: { warn: () => undefined, info: () => undefined },
    decode: (message) => ({ messageId: message.id, text: message.text }),
    messageIdOf: (message) => message.messageId,
    existingMessageIds: async () => new Set([""]),
    publish: undefined,
    createTurn: async (_context, message) => {
      appended.push(message.text)
    },
  })

  assert.deepEqual(result, { candidateCount: 1, omittedCount: 0, createdCount: 1 })
  assert.deepEqual(appended, ["without identity"])
})

test("a disabled prepend phase does not read state or produce turns", async () => {
  let touched = false
  const result = await appendPrependedUserTurns({
    context: undefined,
    enabled: false,
    incoming: [{ id: "1" }],
    maximum: 1,
    reminder: undefined,
    turnOptions: {},
    logger: { warn: () => undefined, info: () => undefined },
    decode: (message) => message,
    messageIdOf: (message) => message.id,
    existingMessageIds: async () => { touched = true; return new Set() },
    publish: async () => { touched = true },
    createTurn: async () => { touched = true },
  })

  assert.deepEqual(result, { candidateCount: 0, omittedCount: 0, createdCount: 0 })
  assert.equal(touched, false)
})
