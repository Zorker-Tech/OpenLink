import assert from "node:assert/strict"
import { test } from "node:test"

import { projectThreadSessionKind } from "../../source/adapters/interop/agent/thread-session-kind-adapter.ts"

test("external thread session names become Slate thread categories", () => {
  assert.equal(projectThreadSessionKind("slack_thread"), "thread")
  assert.equal(projectThreadSessionKind(" slack_thread "), "thread")
  assert.equal(projectThreadSessionKind("other"), "other")
  assert.equal(projectThreadSessionKind(""), undefined)
  assert.equal(projectThreadSessionKind("   "), undefined)
  assert.equal(projectThreadSessionKind(undefined), undefined)
  assert.equal(projectThreadSessionKind(null), undefined)
  assert.equal(projectThreadSessionKind(42), "other")
})
