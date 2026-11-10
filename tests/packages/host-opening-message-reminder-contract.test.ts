import assert from "node:assert/strict"
import { test } from "node:test"

import {
  OpeningMessageReminderMiddleware,
  buildOpeningMessageReminder,
  createOpeningMessageReminder,
  hasPlainTextDelivery,
  hasPlainTextDeliveryThisTurn,
  isOpeningMessageReminder,
  isPlainTextDeliveryArgs,
} from "../../source/host/runner/start-of-turn-ack-reminder-middleware.ts"
import { SLATE_SEND_MESSAGE_TOOL_NAME } from "../../source/host/runner/tools/send-message-tool.ts"
import type { MessageLike, PromptExecutor } from "../../source/host/runner/send-message-reminder-middleware.ts"

const user = (content: string): MessageLike => ({ role: "user", content })
const assistant = (...content: Array<Record<string, unknown>>): MessageLike => ({ role: "assistant", content })
const call = (toolName: string, args: unknown): Record<string, unknown> => ({ type: "tool-call", toolName, args })

function executorWith(messages: MessageLike[]) {
  const appended: MessageLike[] = []
  const streams: unknown[][] = []
  let clears = 0
  const executor: PromptExecutor = {
    getMessages: () => messages,
    getState: () => messages,
    clearMessages: () => { clears += 1; messages.splice(0) },
    appendMessages(value) {
      const batch = Array.isArray(value) ? value : [value]
      messages.push(...batch)
      appended.push(...batch)
    },
    stream: (...args) => (streams.push(args), "streamed"),
  }
  return { executor, appended, streams, get clears() { return clears } }
}

test("hidden reminder construction retains the marker that tells transcript readers to ignore it", () => {
  const reminder = buildOpeningMessageReminder("a reminder")
  assert.equal(reminder.role, "user")
  assert.equal(isOpeningMessageReminder(reminder), true)
  assert.deepEqual(reminder.providerOptions?.slate, { slateOpeningMessageReminder: true })
  assert.equal(isOpeningMessageReminder({ role: "user", content: "an earlier reminder", providerOptions: { slate: { slateStartOfTurnAckReminder: true } } }), true)
  assert.equal(isOpeningMessageReminder({ role: "user", content: "a reminder" }), false)
  assert.equal(isOpeningMessageReminder({ role: "user", content: "a reminder", providerOptions: { slate: { slateStartOfTurnAckReminder: "true" } } }), false)
})

test("only a text SendMessage call counts as an opening acknowledgement", () => {
  assert.equal(isPlainTextDeliveryArgs({ type: "text", text: "hello" }), true)
  assert.equal(isPlainTextDeliveryArgs({ type: "widget" }), false)
  assert.equal(hasPlainTextDelivery(assistant(call(SLATE_SEND_MESSAGE_TOOL_NAME, { type: "text", text: "hello" }))), true)
  assert.equal(hasPlainTextDelivery(assistant(call(SLATE_SEND_MESSAGE_TOOL_NAME, { type: "attachment" }))), false)
  assert.equal(hasPlainTextDelivery(assistant(call("Shell", { type: "text" }))), false)
  assert.equal(hasPlainTextDelivery(user("hello")), false)
})

test("the turn scan skips injected reminders and stops at the latest user or system boundary", () => {
  const toolOnly = [user("help"), assistant(call("Shell", {})), buildOpeningMessageReminder("hidden")]
  const acknowledged = [user("help"), assistant(call("Shell", {})), buildOpeningMessageReminder("hidden"), assistant(call(SLATE_SEND_MESSAGE_TOOL_NAME, { type: "text" }))]
  const nextUser = [...acknowledged, user("follow up")]

  assert.equal(hasPlainTextDeliveryThisTurn(toolOnly), false)
  assert.equal(hasPlainTextDeliveryThisTurn(acknowledged), true)
  assert.equal(hasPlainTextDeliveryThisTurn(nextUser), false)
  assert.equal(hasPlainTextDeliveryThisTurn([{ role: "system", content: "new turn" }, assistant(call(SLATE_SEND_MESSAGE_TOOL_NAME, { type: "text" }))]), true)
})

test("the middleware adds one marked reminder after the threshold and forwards the stream", () => {
  const world = executorWith([user("do the task"), assistant(call("Shell", {}), call("Read", {}))])
  const middleware = createOpeningMessageReminder({ threshold: 1, message: "first-party reminder" })(world.executor)

  assert.equal(middleware.stream("request", 3), "streamed")
  assert.deepEqual(world.streams, [["request", 3]])
  assert.equal(world.appended.length, 1)
  assert.equal(isOpeningMessageReminder(world.appended[0]!), true)
  assert.equal(world.appended[0]?.content, "first-party reminder")

  middleware.stream("second")
  assert.equal(world.appended.length, 1)
})

test("a send before the threshold prevents a reminder and executor state operations pass through", () => {
  const world = executorWith([user("do the task"), assistant(call(SLATE_SEND_MESSAGE_TOOL_NAME, { type: "text" }), call("Shell", {}), call("Read", {}))])
  const middleware = new OpeningMessageReminderMiddleware(world.executor, 1, buildOpeningMessageReminder("custom"))

  assert.equal(middleware.stream(), "streamed")
  assert.equal(world.appended.length, 0)
  assert.equal(middleware.getMessages(), world.executor.getMessages())
  assert.equal(middleware.getState(), world.executor.getState())
  middleware.clearMessages()
  assert.equal(world.clears, 1)
})
