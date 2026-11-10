import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createSlateTranscriptOccurrenceCodec,
  createGeneratedTranscriptOccurrenceCodec,
  type GeneratedTranscriptOccurrenceBindings,
} from "../../source/adapters/interop/agent/transcript-occurrence-codec-adapter.ts";
import { UserMessage } from "../../source/adapters/interop/proto/generated/agent/v1/agent_pb.ts";
import { createSlateAgentConversationTurn } from "../../source/packages/agent/conversation-turn-state.ts";
import { slateConversationTurnSerde } from "../../source/adapters/interop/agent/agent-conversation-state-serdes-adapter.ts";
import { createSlateAssistantMessageStep } from "../../source/packages/agent/conversation-step-state.ts";
import {
  createSlateConversationStepSerde,
  createSlateUserMessageSerde,
} from "../../source/adapters/interop/agent/agent-state-message-serdes-adapter.ts";
import { fromInteropUserMessage } from "../../source/adapters/interop/agent/user-message-action-protocol-adapter.ts";
import { createRedactedString } from "../../source/packages/redaction/create.ts";
import { DataClassification } from "../../source/packages/redaction/classification.ts";
import { PrivacyMode } from "../../source/packages/redaction/privacy-mode.ts";
import type { DecodedTranscriptStep, DecodedTranscriptTurn, TranscriptOccurrenceCodec } from "../../source/host/transcript/mirror/transcript-occurrence-deriver.ts";

const bytes = (...values: number[]) => new Uint8Array(values);
function fakeBindings(overrides: Partial<Record<"ConversationTurnStructure" | "UserMessage" | "ConversationStep", unknown>> = {}) {
  const tables = {
    ConversationTurnStructure: new Map<number, unknown>(),
    UserMessage: new Map<number, unknown>(),
    ConversationStep: new Map<number, unknown>(),
  };
  const make = (name: keyof typeof tables) => ({ fromBinary(input: Uint8Array) { const value = tables[name].get(input[0] ?? 0); if (value === undefined) throw new Error("no wire value"); return value; } });
  const bindings: GeneratedTranscriptOccurrenceBindings = {
    ConversationTurnStructure: (overrides.ConversationTurnStructure ?? make("ConversationTurnStructure")) as never,
    UserMessage: (overrides.UserMessage ?? make("UserMessage")) as never,
    ConversationStep: (overrides.ConversationStep ?? make("ConversationStep")) as never,
  };
  return { bindings, tables };
}
function codecWith() {
  const world = fakeBindings();
  const codec = createGeneratedTranscriptOccurrenceCodec(world.bindings);
  return { ...world, codec };
}
const json = (value: unknown) => ({ toJson: () => value });

test("the codec requires all three generated constructors", () => {
  const world = fakeBindings();
  assert.throws(() => createGeneratedTranscriptOccurrenceCodec({ ...world.bindings, UserMessage: undefined as never }), (error: unknown) => error instanceof TypeError && /generated UserMessage\.fromBinary is required/.test((error as Error).message));
  assert.throws(() => createGeneratedTranscriptOccurrenceCodec({ ...world.bindings, ConversationStep: { fromBinary: 5 } as never }), (error: unknown) => error instanceof TypeError && /generated ConversationStep\.fromBinary is required/.test((error as Error).message));
});

test("a turn decodes its case, user message and steps", () => {
  const { tables, codec } = codecWith();
  tables.ConversationTurnStructure.set(1, { turn: { case: "agentConversationTurn", value: { userMessage: bytes(9), steps: [bytes(2), bytes(3)] } } });
  tables.ConversationTurnStructure.set(2, { turn: { case: "shellConversationTurn", value: {} } });
  tables.ConversationTurnStructure.set(3, { turn: { case: undefined } });
  assert.deepEqual(codec.decodeTurn(bytes(1)), { case: "agent", userMessage: bytes(9), steps: [bytes(2), bytes(3)] });
  assert.deepEqual(codec.decodeTurn(bytes(2)), { case: "shell" });
  assert.deepEqual(codec.decodeTurn(bytes(3)), { case: undefined });
});

test("a user message decodes its text and optional blob id", () => {
  const { tables, codec } = codecWith();
  tables.UserMessage.set(1, { text: "hello" });
  tables.UserMessage.set(2, { text: "with blob", textBlobId: bytes(7) });
  assert.deepEqual(codec.decodeUserMessage(bytes(1)), { text: "hello" });
  assert.deepEqual(codec.decodeUserMessage(bytes(2)), { text: "with blob", textBlobId: bytes(7) });
});

test("an assistant or thinking message decodes as its step", () => {
  const { tables, codec } = codecWith();
  tables.ConversationStep.set(1, { message: { case: "assistantMessage", value: { text: "answer" } } });
  tables.ConversationStep.set(2, { message: { case: "thinkingMessage", value: { text: "hmm" } } });
  tables.ConversationStep.set(3, { message: { case: undefined } });
  assert.deepEqual(codec.decodeStep(bytes(1)), { case: "assistant", text: "answer" });
  assert.deepEqual(codec.decodeStep(bytes(2)), { case: "thinking", text: "hmm" });
  assert.deepEqual(codec.decodeStep(bytes(3)), { case: undefined });
});

test("a tool call step decodes its generated name, input and result", () => {
  const { tables, codec } = codecWith();
  tables.ConversationStep.set(1, {
    message: {
      case: "toolCall",
      value: {
        tool: {
          case: "readFileToolCall",
          value: { args: Object.assign(json({ path: "/tmp/x" }), { toolName: undefined }), result: json({ ok: true }) },
        },
      },
    },
  });
  tables.ConversationStep.set(2, {
    message: {
      case: "toolCall",
      value: { tool: { case: "shellToolCall", value: { args: json({ cmd: "ls" }) } } },
    },
  });
  assert.deepEqual(codec.decodeStep(bytes(1)), { case: "tool", name: "read_file", input: { path: "/tmp/x" }, result: { ok: true } });
  assert.deepEqual(codec.decodeStep(bytes(2)), { case: "tool", name: "shell", input: { cmd: "ls" } });
});

test("an mcp tool call is named by its generated args or falls back", () => {
  const { tables, codec } = codecWith();
  tables.ConversationStep.set(1, { message: { case: "toolCall", value: { tool: { case: "mcpToolCall", value: { args: Object.assign(json({}), { toolName: "search" }) } } } } });
  tables.ConversationStep.set(2, { message: { case: "toolCall", value: { tool: { case: "mcpToolCall", value: { args: Object.assign(json({}), { name: "fetch" }) } } } } });
  tables.ConversationStep.set(3, { message: { case: "toolCall", value: { tool: { case: "mcpToolCall", value: { args: json({}) } } } } });
  tables.ConversationStep.set(4, { message: { case: "toolCall", value: { tool: { case: "mcpToolCall", value: {} } } } });
  assert.equal((codec.decodeStep(bytes(1)) as { name: string }).name, "search");
  assert.equal((codec.decodeStep(bytes(2)) as { name: string }).name, "fetch");
  assert.equal((codec.decodeStep(bytes(3)) as { name: string }).name, "mcp");
  assert.equal((codec.decodeStep(bytes(4)) as { name: string }).name, "mcp");
});

test("a tool call without a case or with no args decodes to an empty input", () => {
  const { tables, codec } = codecWith();
  tables.ConversationStep.set(1, { message: { case: "toolCall", value: { tool: { case: undefined } } } });
  tables.ConversationStep.set(2, { message: { case: "toolCall", value: { tool: { case: "unknownToolCall", value: {} } } } });
  assert.deepEqual(codec.decodeStep(bytes(1)), { case: undefined });
  assert.deepEqual(codec.decodeStep(bytes(2)), { case: "tool", name: "unknown", input: {} });
});

test("a lowerCamel tool case becomes snake_case", () => {
  const { tables, codec } = codecWith();
  tables.ConversationStep.set(1, { message: { case: "toolCall", value: { tool: { case: "someHTTPToolCall", value: { args: json({}) } } } } });
  assert.equal((codec.decodeStep(bytes(1)) as { name: string }).name, "some_http");
});

test("the codec keeps the generated collaborators in its closure", () => {
  const { bindings, tables } = fakeBindings();
  const codec: TranscriptOccurrenceCodec = createGeneratedTranscriptOccurrenceCodec(bindings);
  tables.UserMessage.set(5, { text: "later" });
  tables.ConversationTurnStructure.set(0, { turn: { case: undefined } });
  tables.ConversationStep.set(0, { message: { case: undefined } });
  assert.deepEqual(codec.decodeUserMessage(bytes(5)), { text: "later" });
  // The interface shapes it produces are the deriver's own.
  const turn: DecodedTranscriptTurn = codec.decodeTurn(bytes(0));
  const step: DecodedTranscriptStep = codec.decodeStep(bytes(0));
  assert.equal(turn.case, undefined);
  assert.equal(step.case, undefined);
});

test("the Slate production codec reads Slate turn and step envelopes", () => {
  const codec = createSlateTranscriptOccurrenceCodec();
  const slateUserBytes = createSlateUserMessageSerde(PrivacyMode.NO_STORAGE).serialize(
    fromInteropUserMessage(new UserMessage({ text: "Slate transcript prompt", messageId: "prompt-1", textBlobId: bytes(6) })),
  );
  assert.deepEqual(codec.decodeUserMessage(slateUserBytes), {
    text: "Slate transcript prompt",
    textBlobId: bytes(6),
  });
  const userMessageId = bytes(7);
  const stepId = bytes(8);
  const turn = createSlateAgentConversationTurn({
    userMessageBlobId: userMessageId,
    stepBlobIds: [stepId],
    sendMessageStepIndices: [],
  });
  const slateBytes = slateConversationTurnSerde.serialize(turn);
  assert.deepEqual(codec.decodeTurn(slateBytes), { case: "agent", userMessage: userMessageId, steps: [stepId] });
  const stepBytes = createSlateConversationStepSerde(PrivacyMode.NO_STORAGE).serialize(
    createSlateAssistantMessageStep(createRedactedString("answer", DataClassification.CODE, "text", PrivacyMode.NO_STORAGE)),
  );
  assert.deepEqual(codec.decodeStep(stepBytes), { case: "assistant", text: "answer" });
});

