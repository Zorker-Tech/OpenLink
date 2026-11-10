import assert from "node:assert/strict"
import { test } from "node:test"

import { isThreadBoundSession } from "../../source/packages/agent/prompts/thread-bound-session.ts"

test("only a thread surface with no conflicting kind or a Slate thread kind is bound", () => {
  assert.equal(isThreadBoundSession({ isThreadSurface: true }), true)
  assert.equal(isThreadBoundSession({ isThreadSurface: true, sessionKind: "thread" }), true)
  assert.equal(isThreadBoundSession({ isThreadSurface: true, sessionKind: undefined }), true)
  assert.equal(isThreadBoundSession({ isThreadSurface: true, sessionKind: "other" }), false)
  assert.equal(isThreadBoundSession({ isThreadSurface: false, sessionKind: "thread" }), false)
  assert.equal(isThreadBoundSession({}), false)
})
