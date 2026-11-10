import assert from "node:assert/strict"
import { test } from "node:test"

import { encodeSlateExecutorSubagentConfig } from "../../source/adapters/interop/agent/multitask-subagent-config-adapter.ts"
import { createSlateExecutorSubagentDefinition, SLATE_MULTITASK_PROMPT_SECTION } from "../../source/host/slate-multitask.ts"

test("Slate's executor-worker definition is encoded as the generated host subagent shape", () => {
  const definition = createSlateExecutorSubagentDefinition()
  const wireConfig = encodeSlateExecutorSubagentConfig(definition)

  assert.equal(definition.typeName, "executor")
  assert.equal(definition.preserveTaskTool, false)
  assert.equal(definition.subagentSource, "builtin")
  assert.match(definition.description, /background worker/)
  assert.equal(wireConfig.subagent_type.type.case, "custom")
  if (wireConfig.subagent_type.type.case !== "custom") throw new Error("expected a custom executor type")
  assert.equal(wireConfig.subagent_type.type.value.name, definition.typeName)
  assert.equal(wireConfig.description, definition.description)
  assert.equal(wireConfig.preserveTaskTool, false)
  assert.equal(wireConfig.subagentSource, "builtin")
})

test("multitask guidance preserves delegation, delivery and follow-up rules", () => {
  assert.match(SLATE_MULTITASK_PROMPT_SECTION, /SendMessage/)
  assert.match(SLATE_MULTITASK_PROMPT_SECTION, /MessageSubagent/)
  assert.match(SLATE_MULTITASK_PROMPT_SECTION, /self-contained/)
  assert.match(SLATE_MULTITASK_PROMPT_SECTION, /Do not describe workers/)
})
