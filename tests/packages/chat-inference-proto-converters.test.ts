import { test } from "node:test"
import assert from "node:assert/strict"

import {
  applyToolCallArgs,
  buildStreamRequest,
  coreMessageToProto,
  protoStreamErrorToError,
  toolCallArgsFromProto,
} from "../../source/adapters/interop/chat-inference-proto/converters.ts"
import {
  InferenceStreamErrorType,
  InferenceToolCall,
} from "../../source/adapters/interop/proto/generated/aiserver/v1/inference_pb.ts"
import { InputTokenLimitError, OutputTokensLimitExceededError } from "../../source/packages/chat-inference/prompt-executor.ts"

// ---------------------------------------------------------------------------------------------
// arguments and messages
// ---------------------------------------------------------------------------------------------

const toolCall = () => new InferenceToolCall({ toolCallId: "call-1", toolName: "Read" })
const jsonOf = (message: { toJson(): any }): any => message.toJson()

test("tool call arguments take an object as JSON, or anything else as raw text", () => {
  const objectCall = toolCall()
  applyToolCallArgs(objectCall, { path: "/a" })
  assert.deepEqual(jsonOf(objectCall).args, { path: "/a" })
  assert.equal(jsonOf(objectCall).rawToolCallArgs, undefined)

  const rawCall = toolCall()
  applyToolCallArgs(rawCall, "not json", "explicit")
  assert.equal(rawCall.args, undefined)
  assert.equal(jsonOf(rawCall).rawToolCallArgs, "explicit")

  const arrayCall = toolCall()
  applyToolCallArgs(arrayCall, [1, 2])
  assert.equal(jsonOf(arrayCall).rawToolCallArgs, "[1,2]")

  const numberCall = toolCall()
  applyToolCallArgs(numberCall, 7)
  assert.equal(jsonOf(numberCall).rawToolCallArgs, "7")
  assert.throws(() => applyToolCallArgs(toolCall(), undefined), /cannot represent tool call arguments of type undefined as a JSON object or raw text/)
  assert.throws(() => applyToolCallArgs(toolCall(), () => {}), /cannot represent tool call arguments of type function as a JSON object or raw text/)
})

test("tool call arguments read back from either representation", () => {
  const withArgs = toolCall()
  applyToolCallArgs(withArgs, { path: "/a" })
  assert.deepEqual(toolCallArgsFromProto(withArgs), { path: "/a" })
  const withRaw = toolCall()
  applyToolCallArgs(withRaw, "raw")
  assert.equal(toolCallArgsFromProto(withRaw), "raw")
  assert.deepEqual(toolCallArgsFromProto(toolCall()), {})
})

test("a user message becomes text or parts", () => {
  assert.deepEqual(jsonOf(coreMessageToProto({ role: "user", content: "hello" })), { role: "INFERENCE_MESSAGE_ROLE_USER", text: "hello" })
  assert.deepEqual(jsonOf(coreMessageToProto({ role: "user", content: [{ type: "text", text: "hi" }] })), {
    role: "INFERENCE_MESSAGE_ROLE_USER",
    parts: { parts: [{ text: { text: "hi" } }] },
  })
})

test("every kind of user part becomes the part it names, or an empty text", () => {
  const message = jsonOf(coreMessageToProto({
    role: "user",
    content: [
      { type: "text", text: "hi" },
      { type: "image", image: "https://example.invalid/a.png", mimeType: "image/webp" },
      { type: "image", image: new Uint8Array([1, 2, 3]) },
      { type: "file", name: "report.pdf" },
      { type: "unknown" },
    ],
  }))
  assert.deepEqual(message.parts.parts[0], { text: { text: "hi" } })
  assert.deepEqual(message.parts.parts[1], { image: { data: "https://example.invalid/a.png", mimeType: "image/webp" } })
  assert.equal(message.parts.parts[2].image.data, "data:image/png;base64,AQID")
  assert.deepEqual(message.parts.parts[3], { text: { text: "[File: report.pdf]" } })
  assert.deepEqual(message.parts.parts[4], { text: {} })
})

test("an assistant message keeps its text, calls, reasoning and provider metadata", () => {
  const message = jsonOf(coreMessageToProto({
    role: "assistant",
    providerOptions: { cursor: { modelProviderMessageId: "msg-1", openaiPhase: null } },
    content: [
      { type: "text", text: "thinking out loud" },
      { type: "tool-call", toolCallId: "call-1", toolName: "Read", args: { path: "/a" } },
      { type: "reasoning", text: "reason", signature: "sig", providerOptions: { cursor: { modelName: "model-x" } } },
      { type: "redacted-reasoning", data: "redacted" },
    ],
  }))
  assert.equal(message.role, "INFERENCE_MESSAGE_ROLE_ASSISTANT")
  assert.equal(message.modelProviderMessageId, "msg-1")
  assert.equal(message.openaiPhaseNull, true)
  assert.equal(message.text, "thinking out loud")
  assert.deepEqual(message.toolCalls, [{ toolCallId: "call-1", toolName: "Read", args: { path: "/a" } }])
  assert.deepEqual(message.reasoningParts, [{ text: "reason", signature: "sig", modelName: "model-x" }, { isRedacted: true, redactedData: "redacted" }])
})

test("a string assistant message has no parts, and an openai phase can be a word", () => {
  const message = jsonOf(coreMessageToProto({ role: "assistant", content: "answer", providerOptions: { cursor: { openaiPhase: "final" } } }))
  assert.equal(message.text, "answer")
  assert.equal(message.openaiPhase, "final")
})

test("a tool message carries each result in the protocol's shape", () => {
  const message = jsonOf(coreMessageToProto({
    role: "tool",
    content: [
      { type: "tool-result", toolCallId: "call-1", toolName: "Read", result: "text result" },
      { type: "tool-result", toolCallId: "call-2", toolName: "Read", result: { ok: true }, isError: true, experimental_content: [{ type: "text", text: "extra" }] },
      { type: "text", text: "ignored" },
    ],
  }))
  const parts = message.toolContent.parts
  assert.equal(parts.length, 2)
  assert.equal(parts[0].result, "text result")
  assert.equal(parts[1].isError, true)
  assert.deepEqual(parts[1].experimentalContent, [{ text: { text: "extra" } }])
})

test("a system message is its text and an unknown role has none", () => {
  assert.deepEqual(jsonOf(coreMessageToProto({ role: "system", content: "be good" })), { role: "INFERENCE_MESSAGE_ROLE_SYSTEM", text: "be good" })
  assert.deepEqual(jsonOf(coreMessageToProto({ role: "developer", content: "x" })), {})
})

// ---------------------------------------------------------------------------------------------
// errors and requests
// ---------------------------------------------------------------------------------------------

test("a stream error becomes the error kind it names", () => {
  const typed = protoStreamErrorToError({
    errorType: InferenceStreamErrorType.INPUT_TOKEN_LIMIT,
    message: "input is too long",
    isInputTokenLimitError: false,
    isOutputTokenLimitError: false,
  } as never)
  assert.equal(typed instanceof InputTokenLimitError, true)
  assert.equal(typed.message, "input is too long")
  const flagged = protoStreamErrorToError({ message: "output is too long", isOutputTokenLimitError: true } as never)
  assert.equal(flagged instanceof OutputTokensLimitExceededError, true)
  const plain = protoStreamErrorToError({ message: "provider down" } as never)
  assert.equal(plain instanceof Error, true)
  assert.equal(plain.message, "provider down")
})

test("a stream request carries messages, tools and the options it was given", () => {
  const request = jsonOf(buildStreamRequest({
    messages: [{ role: "user", content: "hi" }],
    requestedModel: { modelId: "composer-2", maxMode: true, parameters: [{ id: "temperature", value: "0.5" }], builtInModel: true, isVariantStringRepresentation: false },
    tools: [{ name: "Read", description: "read a file", parameters: { type: "object" }, customToolFormat: { syntax: "json" } }],
    providerDefinedTools: [{ name: "web", id: "web-1", type: "function", options: { url: "x" } }],
    acceptedUnadvertisedToolNames: ["Extra"],
    modelConfig: { maxTokens: 100, temperature: 0.2, topP: 0.9, stopSequences: ["END"] },
    invocationId: "inv-1",
    conversationId: "conv-1",
    automationId: "auto-1",
    inferenceReason: 2 as never,
  }))
  assert.equal(request.messages.length, 1)
  assert.equal(request.tools.length, 1)
  assert.equal(request.tools[0].customToolFormat.syntax, "json")
  assert.equal(request.providerDefinedTools.length, 1)
  assert.deepEqual(request.acceptedUnadvertisedToolNames, ["Extra"])
  assert.equal(request.requestedModel.modelId, "composer-2")
  assert.equal(request.invocationId, "inv-1")
  assert.equal(request.conversationId, "conv-1")
  assert.equal(request.automationId, "auto-1")
  assert.equal(request.modelConfig.maxTokens, 100)
  assert.deepEqual(request.modelConfig.stopSequences, ["END"])
})

test("a stream request omits what it was not given", () => {
  const request = jsonOf(buildStreamRequest({
    messages: [],
    requestedModel: { modelId: "composer-2", maxMode: false, parameters: [], builtInModel: false, isVariantStringRepresentation: true },
  }))
  assert.equal(request.messages, undefined)
  assert.equal(request.tools, undefined)
  assert.equal(request.acceptedUnadvertisedToolNames, undefined)
  assert.equal(request.modelConfig, undefined)
  assert.equal(request.invocationId, undefined)
})
// ---------------------------------------------------------------------------------------------
// the edges a conversion keeps
// ---------------------------------------------------------------------------------------------

test("every message role keeps its own name", () => {
  assert.equal(jsonOf(coreMessageToProto({ role: "tool", content: [] })).role, "INFERENCE_MESSAGE_ROLE_TOOL")
  assert.equal(jsonOf(coreMessageToProto({ role: "system", content: "s" })).role, "INFERENCE_MESSAGE_ROLE_SYSTEM")
  assert.equal(jsonOf(coreMessageToProto({ role: "user", content: "u" })).role, "INFERENCE_MESSAGE_ROLE_USER")
  assert.equal(jsonOf(coreMessageToProto({ role: "assistant", content: "a" })).role, "INFERENCE_MESSAGE_ROLE_ASSISTANT")
})

test("provider options on a part are exactly the ones the protocol understands", () => {
  const rich = jsonOf(coreMessageToProto({
    role: "user",
    content: [{
      type: "text",
      text: "hi",
      providerOptions: {
        anthropic: { cacheControl: { type: "ephemeral" } },
        cursor: { imageDescription: "described", imageDescriptions: { "0": "first", bad: "ignored" } },
      },
    }],
  }))
  assert.deepEqual(rich.parts.parts[0], {
    text: { text: "hi", providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } }, cursor: { imageDescription: "described", imageDescriptions: { "0": "first" } } } },
  })
  const empty = jsonOf(coreMessageToProto({
    role: "user",
    content: [{ type: "text", text: "hi", providerOptions: { cursor: { imageDescription: "", imageDescriptions: { bad: "ignored" } } } }],
  }))
  assert.deepEqual(empty.parts.parts[0], { text: { text: "hi" } })
  const emptyCursor = jsonOf(coreMessageToProto({ role: "user", content: [{ type: "text", text: "hi", providerOptions: { cursor: {} } }] }))
  assert.deepEqual(emptyCursor.parts.parts[0], { text: { text: "hi" } })
})

test("an image given as a buffer is carried as bytes", () => {
  const message = jsonOf(coreMessageToProto({ role: "user", content: [{ type: "image", image: new Uint8Array([1, 2]).buffer }] }))
  assert.equal(message.parts.parts[0].image.data, "data:image/png;base64,AQI=")
})

test("adjacent text parts are joined into the message's text", () => {
  const message = jsonOf(coreMessageToProto({
    role: "assistant",
    content: [{ type: "text", text: "one " }, { type: "text", text: "two" }],
  }))
  assert.equal(message.text, "one two")
})

test("a tool call keeps its explicit raw arguments and a result keeps its options", () => {
  const assistant = jsonOf(coreMessageToProto({
    role: "assistant",
    content: [{ type: "tool-call", toolCallId: "call-1", toolName: "Read", args: { path: "/a" }, providerOptions: { cursor: { rawToolCallArgs: "raw-call" } } }],
  }))
  assert.deepEqual(assistant.toolCalls[0], { toolCallId: "call-1", toolName: "Read", args: { path: "/a" }, rawToolCallArgs: "raw-call" })
  const tool = jsonOf(coreMessageToProto({
    role: "tool",
    content: [{ type: "tool-result", toolCallId: "call-1", toolName: "Read", result: "r", providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } } }],
  }))
  assert.deepEqual(tool.toolContent.parts[0].providerOptions, { anthropic: { cacheControl: { type: "ephemeral" } } })
})

test("a typed stream failure is the error it names even without a helpful message", () => {
  const typed = protoStreamErrorToError({
    errorType: InferenceStreamErrorType.INPUT_TOKEN_LIMIT,
    message: "mystery",
    isInputTokenLimitError: false,
    isOutputTokenLimitError: false,
  } as never)
  assert.equal(typed instanceof InputTokenLimitError, true)
  const flagged = protoStreamErrorToError({ message: "mystery", isOutputTokenLimitError: true } as never)
  assert.equal(flagged instanceof OutputTokensLimitExceededError, true)
})

test("the stream request carries the inference reason it was given", () => {
  const request = jsonOf(buildStreamRequest({
    messages: [],
    requestedModel: { modelId: "m", maxMode: false, parameters: [], builtInModel: false, isVariantStringRepresentation: false },
    inferenceReason: 2 as never,
  }))
  assert.equal(request.inferenceReason !== undefined, true)
})

