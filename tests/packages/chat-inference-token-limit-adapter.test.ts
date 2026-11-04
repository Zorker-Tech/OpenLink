import assert from "node:assert/strict"
import { test } from "node:test"

import {
  classifyTokenLimitErrorFromMessage,
  isInputTokenLimitErrorMessage,
  isOutputTokenLimitErrorMessage,
} from "../../source/adapters/interop/chat-inference-proto/token-limit-error-classifier-adapter.ts"

test("external input-limit messages map into the input-token failure", () => {
  const samples = [
    "Input tokens exceed the configured limit; your messages resulted in 16 tokens.",
    "Input token count exceeds the maximum number of tokens allowed.",
    "Input token count plus requested output count exceeds maximum context length.",
    "The maximum prompt length was exceeded; request contains 16 tokens.",
    "Prompt is too long",
    "Input token count is longer than the context length",
    "Input exceeds the context window",
    "Input is too long for requested model",
    "Input length exceeds the maximum allowed input length",
    "Request size cannot exceed 16 bytes; please shorten the request",
    "Input length with max_tokens would exceed context limit",
    "Request size exceeds model context window",
    "Message size is 16 bytes and exceeds the 8 MB limit",
    "context_length_exceeded",
    "payload too large",
    "max tokens of 16 exceeded",
  ]
  for (const message of samples) {
    assert.equal(isInputTokenLimitErrorMessage(message), true, message)
    assert.equal(classifyTokenLimitErrorFromMessage(message)?.name, "InputTokenLimitError", message)
  }
  assert.equal(classifyTokenLimitErrorFromMessage("input token limit exceeded")?.name, "InputTokenLimitError")
})

test("output-limit matching is case-insensitive and wins over mixed limit errors", () => {
  const message = "Input token limit exceeded after the request exceeded max output tokens"
  assert.equal(isOutputTokenLimitErrorMessage(message.toUpperCase()), true)
  assert.equal(classifyTokenLimitErrorFromMessage(message)?.name, "OutputTokensLimitExceededError")
  assert.equal(classifyTokenLimitErrorFromMessage(message)?.message, message)
})

test("ordinary inference failures stay ordinary errors or no match", () => {
  assert.equal(isInputTokenLimitErrorMessage("connection failed"), false)
  assert.equal(isOutputTokenLimitErrorMessage("connection failed"), false)
  assert.equal(classifyTokenLimitErrorFromMessage("connection failed"), undefined)
})
