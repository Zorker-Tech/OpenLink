import assert from "node:assert/strict"
import { test } from "node:test"

import { LEGACY_INTEROP_CONTEXT_TAG_ALIASES } from "../../source/adapters/interop/agent/legacy-context-tag-adapter.ts"

test("historical external context tags stay in the interop adapter", () => {
  assert.deepEqual(LEGACY_INTEROP_CONTEXT_TAG_ALIASES, ["cursor_rules_context"])
})
