import assert from "node:assert/strict"
import { test } from "node:test"

import { encodeFrame } from "../../source/host/extensions/codebase-telemetry/csnaps-protocol.ts"
import { CsnapsRequestMailbox } from "../../source/host/extensions/codebase-telemetry/csnaps-request-mailbox.ts"

function mailbox(): CsnapsRequestMailbox {
  return new CsnapsRequestMailbox({
    process(message, cause) {
      const error = new Error(message, cause === undefined ? undefined : { cause })
      error.name = "CsnapsProcessError"
      return error
    },
    request(method, code) {
      return new Error(`csnaps ${method} request failed: ${code}`)
    },
  })
}

function answer(id: number, result: unknown): Buffer {
  return encodeFrame(Buffer.from(JSON.stringify({ id, ok: true, result })))
}

test("the response mailbox correlates answers even when they arrive out of order", async () => {
  const replies = mailbox()
  const first = replies.open("ping", new AbortController().signal, () => {})
  const second = replies.open("initialize", new AbortController().signal, () => {})

  replies.accept(Buffer.concat([answer(second.id, { second: true }), answer(first.id, { first: true })]))

  assert.deepEqual(await Promise.all([first.response, second.response]), [
    { first: true },
    { second: true },
  ])
})

test("a duplicate answer rejects the frame batch before settling its request", async () => {
  const replies = mailbox()
  const pending = replies.open("ping", new AbortController().signal, () => {})

  assert.throws(() => replies.accept(Buffer.concat([answer(pending.id, {}), answer(pending.id, {})])), /duplicate request ID/)
  replies.rejectAll(new Error("mailbox closed"))
  await assert.rejects(pending.response, /mailbox closed/)
})

test("an unknown answer is refused without stealing another request's response", async () => {
  const replies = mailbox()
  const pending = replies.open("ping", new AbortController().signal, () => {})

  assert.throws(() => replies.accept(answer(pending.id + 10, {})), /unknown request ID/)
  replies.accept(answer(pending.id, { ok: true }))
  assert.deepEqual(await pending.response, { ok: true })
})

test("an aborted request is removed and makes the owning process fail", async () => {
  const failures: Error[] = []
  const replies = mailbox()
  const controller = new AbortController()
  const pending = replies.open("snapshot", controller.signal, error => failures.push(error))

  controller.abort(new Error("turn cancelled"))

  await assert.rejects(pending.response, /request cancelled/)
  assert.equal(failures.length, 1)
  assert.equal(failures[0]?.name, "CsnapsProcessError")
})
