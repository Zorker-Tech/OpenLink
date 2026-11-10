import assert from "node:assert/strict"
import test from "node:test"

import { HookAdditionalContext } from "../../source/adapters/interop/proto/generated/agent/v1/hook_additional_context_pb.ts"
import type { HookContextEntry } from "../../source/packages/hooks-carriers/hook-additional-context.ts"
import {
  fromInteropHookContextMessages,
  toInteropHookContextMessages,
} from "../../source/adapters/interop/agent/hook-context-adapter.ts"

test("hook context crosses the wire boundary by translating between independent shapes", () => {
  const internal: HookContextEntry[] = [{ event: "preToolUse", text: "look twice" }]
  const messages = toInteropHookContextMessages(internal)

  assert.equal(messages.length, 1)
  assert.ok(messages[0] instanceof HookAdditionalContext)
  assert.equal(messages[0]?.hookEventName, "preToolUse")
  assert.equal(messages[0]?.content, "look twice")
  assert.deepEqual(fromInteropHookContextMessages(messages), internal)
})

test("empty collections stay empty in both directions", () => {
  assert.deepEqual(toInteropHookContextMessages([]), [])
  assert.deepEqual(fromInteropHookContextMessages([]), [])
})
