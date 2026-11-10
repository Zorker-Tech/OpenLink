import assert from "node:assert/strict"
import { test } from "node:test"

import * as chatInference from "../../source/packages/chat-inference/index.ts"

test("the chat-inference entry exposes Slate prompt contracts, results, errors and middleware", () => {
  for (const exportedName of [
    "BasePromptBuilder",
    "BasePromptExecutor",
    "BaseMiddleware",
    "createStringResult",
    "createImageResult",
    "InputTokenLimitError",
    "OutputTokensLimitExceededError",
    "ProactiveSummarizationThresholdError",
    "ContinuationInjectorMiddleware",
    "ImageResizingPromptExecutor",
    "PassThroughMiddleware",
    "TracingMiddleware",
    "TrailingEmptyAssistantRemovalMiddleware",
    "createMockPromptExecutor",
  ]) {
    assert.equal(exportedName in chatInference, true, `${exportedName} remains public`)
  }
})

test("generated inference clients remain outside the Slate package entry", () => {
  assert.equal("ProtoPromptBuilder" in chatInference, false)
  assert.equal("createProtoSessionProvider" in chatInference, false)
  assert.equal("coreMessageToProto" in chatInference, false)
})
