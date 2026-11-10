import assert from "node:assert/strict"
import { test } from "node:test"

import { isLargeContextModelName } from "../../source/adapters/interop/inference/model-capability-adapter.ts"
import {
  INTEROP_TOOL_MARKER_TOKENS,
  stripInteropToolMarkerTokens,
} from "../../source/adapters/interop/inference/tool-marker-adapter.ts"

test("recognized external model-name fragments map to Slate's large-context behavior", () => {
  for (const modelName of ["dsv3-0324", "kimi2p5", "KIMI-K2P5-turbo", "titanium-latest", "vendor-kimi2p5-trial"]) {
    assert.equal(isLargeContextModelName(modelName), true, modelName)
  }
  for (const modelName of [undefined, null, "", "gpt-5", "dsv2", "titan"] as const) {
    assert.equal(isLargeContextModelName(modelName), false, String(modelName))
  }
})

test("the interop marker list stays exact and each listed token is removed without trimming other text", () => {
  const expectedMarkers = [
    "<｜tool▁calls▁begin｜>", "<｜tool▁calls▁end｜>", "<｜tool▁call▁begin｜>", "<｜tool▁call▁end｜>",
    "<｜tool▁outputs▁begin｜>", "<｜tool▁outputs▁end｜>", "<｜tool▁output▁begin｜>", "<｜tool▁output▁end｜>",
    "<｜tool▁sep｜>", "<|redacted_tool_calls_begin|>", "<|redacted_tool_calls_end|>", "<|redacted_tool_call_begin|>",
    "<|redacted_tool_call_end|>", "<|redacted_tool_outputs_begin|>", "<|redacted_tool_outputs_end|>", "<|redacted_tool_output_begin|>",
    "<|redacted_tool_output_end|>", "<|redacted_tool_sep|>",
  ]
  assert.deepEqual(INTEROP_TOOL_MARKER_TOKENS, expectedMarkers)

  const input = `before ${expectedMarkers.join(" middle ")} after`
  const expectedText = expectedMarkers.reduce((text, marker) => text.replaceAll(marker, ""), input)
  const stripped = stripInteropToolMarkerTokens(input)
  assert.equal(stripped.text, expectedText)
  assert.deepEqual(stripped.removedMarkers, expectedMarkers)
})

test("repeated protocol markers are removed everywhere but reported once, and ordinary text is unchanged", () => {
  const marker = INTEROP_TOOL_MARKER_TOKENS[0]!
  assert.deepEqual(stripInteropToolMarkerTokens(`a${marker}b${marker}c`), {
    text: "abc",
    removedMarkers: [marker],
  })
  assert.deepEqual(stripInteropToolMarkerTokens("ordinary arguments"), {
    text: "ordinary arguments",
    removedMarkers: [],
  })
})
