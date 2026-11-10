/**
 * Reading the generated transcript messages this platform keeps, and the memory this build assembles out of them.
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { AgentConversationTurnStructure, AssistantMessage, ConversationStep, ConversationTurnStructure, ShellConversationTurnStructure, ThinkingMessage, ToolCall, UserMessage } from "../../source/adapters/interop/proto/generated/agent/v1/agent_pb.ts";
import { McpArgs } from "../../source/adapters/interop/proto/generated/agent/v1/mcp_exec_pb.ts";
import { McpToolCall } from "../../source/adapters/interop/proto/generated/agent/v1/mcp_tool_pb.ts";
import { ShellArgs } from "../../source/adapters/interop/proto/generated/agent/v1/shell_exec_pb.ts";
import { ShellToolCall } from "../../source/adapters/interop/proto/generated/agent/v1/shell_tool_pb.ts";
import { UpdateTodosToolCall } from "../../source/adapters/interop/proto/generated/agent/v1/todo_tool_pb.ts";
import { createGeneratedTranscriptOccurrenceCodec } from "../../source/adapters/interop/agent/transcript-occurrence-codec-adapter.ts";
import { createMemoryProductionExtras } from "../../source/host/memory/production.ts";
import { getSlateAgentsRootDir } from "../../source/host/storage/agent-paths.ts";
import { getSlateRootDir } from "../../source/host/host-paths.ts";
import { SLATE_SUMMARIZATION_MODEL_ID } from "../../source/shared/agents/slate-agent-model.ts";
import { MEMORY_SYNTHESIS_DEBOUNCE_MS, MEMORY_SYNTHESIS_DEADLINE_MS, MEMORY_SYNTHESIS_POLL_INTERVAL_MS, MEMORY_SYNTHESIS_RETRY_ATTEMPTS, MEMORY_SYNTHESIS_RETRY_INITIAL_MS, MEMORY_SYNTHESIS_RETRY_MAX_MS } from "../../source/host/memory/memory-synthesis-service.ts";
import { MEMORY_CHANGE_DEBOUNCE_MS } from "../../source/host/memory/memory-service.ts";

/** The generated messages this platform writes, as the platform writes them. */
const bindings = { ConversationTurnStructure, UserMessage, ConversationStep };

describe("reading the generated transcript messages", () => {
  it("refuses bindings that could not decode anything", () => {
    assert.throws(() => createGeneratedTranscriptOccurrenceCodec({} as never), { name: "TypeError", message: "generated ConversationTurnStructure.fromBinary is required" });
    assert.throws(() => createGeneratedTranscriptOccurrenceCodec({ ...bindings, UserMessage: undefined } as never), { name: "TypeError", message: "generated UserMessage.fromBinary is required" });
    assert.throws(() => createGeneratedTranscriptOccurrenceCodec({ ConversationTurnStructure, UserMessage } as never), { name: "TypeError", message: "generated ConversationStep.fromBinary is required" });
  });

  it("reads a turn as the kind of turn it is", () => {
    const codec = createGeneratedTranscriptOccurrenceCodec(bindings as never);
    // A turn refers to its message and its steps by the blobs they were written as.
    const agentTurn = new ConversationTurnStructure({ turn: { case: "agentConversationTurn", value: new AgentConversationTurnStructure({ userMessage: new TextEncoder().encode("user-blob"), steps: [new TextEncoder().encode("step-blob")] }) } });
    const read = codec.decodeTurn(agentTurn.toBinary());
    assert.deepEqual({ kind: read.case, user: read.case === "agent" ? new TextDecoder().decode(read.userMessage) : null, steps: read.case === "agent" ? read.steps.map((step) => new TextDecoder().decode(step)) : [] }, { kind: "agent", user: "user-blob", steps: ["step-blob"] });
    // A shell turn is a turn of a kind this platform has, and one that says nothing is neither.
    assert.equal(codec.decodeTurn(new ConversationTurnStructure({ turn: { case: "shellConversationTurn", value: new ShellConversationTurnStructure({}) } }).toBinary()).case, "shell");
    assert.equal(codec.decodeTurn(new ConversationTurnStructure({}).toBinary()).case, undefined);
  });

  it("reads a user's message, with the blob it may have kept its words in", () => {
    const codec = createGeneratedTranscriptOccurrenceCodec(bindings as never);
    assert.deepEqual(codec.decodeUserMessage(new UserMessage({ text: "hello" }).toBinary()), { text: "hello" });
    const withBlob = codec.decodeUserMessage(new UserMessage({ text: "", textBlobId: new Uint8Array([1, 2, 3]) }).toBinary());
    assert.deepEqual({ text: withBlob.text, blob: Array.from(withBlob.textBlobId ?? []) }, { text: "", blob: [1, 2, 3] });
  });

  it("reads a step as what the agent said, thought or did", () => {
    const codec = createGeneratedTranscriptOccurrenceCodec(bindings as never);
    const step = (message: ConstructorParameters<typeof ConversationStep>[0]) => codec.decodeStep(new ConversationStep(message).toBinary());
    assert.deepEqual(step({ message: { case: "assistantMessage", value: new AssistantMessage({ text: "here you go" }) } }), { case: "assistant", text: "here you go" });
    assert.deepEqual(step({ message: { case: "thinkingMessage", value: new ThinkingMessage({ text: "hmm" }) } }), { case: "thinking", text: "hmm" });
    // A tool call is named as the platform names it, with what it was given and, once it has one, what it answered.
    const shell = step({ message: { case: "toolCall", value: new ToolCall({ tool: { case: "shellToolCall", value: new ShellToolCall({ args: new ShellArgs({ command: "ls -la", workingDirectory: "/workspace" }) }) } }) } });
    assert.equal(shell.case, "tool");
    assert.equal(shell.case === "tool" ? shell.name : "", "shell");
    // What the tool was given and answered is the generated JSON the platform reads, not a shape of its own.
    assert.deepEqual(shell.case === "tool" ? shell.input : null, { command: "ls -la", workingDirectory: "/workspace" });
    assert.equal(shell.case === "tool" ? shell.result : "none", undefined);
    // A name that runs words together is read back as the words it was made of.
    const todos = step({ message: { case: "toolCall", value: new ToolCall({ tool: { case: "updateTodosToolCall", value: new UpdateTodosToolCall({ args: { todos: [] } }) } }) } });
    assert.equal(todos.case === "tool" ? todos.name : "", "update_todos");
    // A tool that came from somewhere else keeps the name it was called by.
    const mcp = step({ message: { case: "toolCall", value: new ToolCall({ tool: { case: "mcpToolCall", value: new McpToolCall({ args: new McpArgs({ name: "search", toolName: "search_the_web", providerIdentifier: "provider-one" }) }) } }) } });
    assert.equal(mcp.case === "tool" ? mcp.name : "", "search_the_web");
    // A step that carries no tool, and one that is not a message at all, are neither.
    assert.deepEqual(step({ message: { case: "toolCall", value: new ToolCall({}) } }), { case: undefined });
    assert.deepEqual(step({}), { case: undefined });
  });
});

describe("the memory this build assembles", () => {
  function harness() {
    const reports: unknown[] = [];
    const sessions: Array<{ modelId: string; isSummarizationSession: boolean; skipLabeling: boolean }> = [];
    const executor = { stream: () => undefined };
    const context = {
      deps: {
        experiments: { pinGateOnAuthenticatedBootstrap: () => {} },
        inference: { port: { createSession: (_onRequestId: (requestId: string) => void, options: { modelId: string; isSummarizationSession: boolean; skipLabeling: boolean }) => { sessions.push(options); return { getExecutor: () => executor }; } } },
        telemetry: { logs: { reportMemorySynthesis: (report: unknown) => { reports.push(report); } } },
      },
    };
    return { context, reports, sessions, executor };
  }

  it("runs under the platform's own root, with the memory it watches", () => {
    const { context } = harness();
    const extras = createMemoryProductionExtras(context as never);
    assert.equal(extras.slateRoot, getSlateRootDir());
    assert.equal(extras.agentsRootDir, getSlateAgentsRootDir());
    // The debounce that coalesces what a conversation writes is the platform's own, named as ours.
    assert.equal(extras.debounce.name, "slate-memory-change");
    assert.equal(typeof extras.debounce.wrap(() => {}), "function");
    assert.equal(MEMORY_CHANGE_DEBOUNCE_MS, 50);
  });

  it("reviews what is remembered on the platform's own schedule, through a summarization session", () => {
    const { context, sessions, executor, reports } = harness();
    const extras = createMemoryProductionExtras(context as never);
    const slateRoot = mkdtempSync(join(tmpdir(), "slate-memory-production-"));
    const store = { store: true };
    const synthesis = extras.createSynthesis({ synthesisTargetForAgent: (agentId: string) => (agentId === "known" ? store : null), listSynthesisTargets: () => [{ agentId: "known", store }] } as never) as unknown as { options: { debounce?: { name: string }; deadline?: { name: string }; polling?: { name: string }; retry?: { name: string }; listTargets?: () => unknown; getTarget?: (agentId: string) => unknown; createExecutor?: (stage: string) => unknown; report?: (event: unknown) => void }; dispose(): void };
    try {
      // Every schedule the review follows is the platform's own, with the names ours.
      assert.deepEqual({
        debounce: synthesis.options.debounce?.name,
        deadline: synthesis.options.deadline?.name,
        polling: synthesis.options.polling?.name,
        retry: synthesis.options.retry?.name,
      }, {
        debounce: "slate-memory-synthesis",
        deadline: "slate-memory-synthesis-inference",
        polling: "slate-memory-temporal-refresh",
        retry: "slate-memory-synthesis-retry",
      });
      // The reviews it is given are the memory service's own agents.
      assert.deepEqual(synthesis.options.listTargets?.(), [{ agentId: "known", target: store }]);
      assert.equal(synthesis.options.getTarget?.("known"), store);
      assert.equal(synthesis.options.getTarget?.("unknown"), null);
      // What reviews is a summarization session of the platform's summarization model, and asks for nothing else.
      assert.equal(synthesis.options.createExecutor?.("synthesis"), executor);
      assert.deepEqual(sessions, [{ modelId: SLATE_SUMMARIZATION_MODEL_ID, isSummarizationSession: true, skipLabeling: true }]);
      // What the review reports goes to the platform's telemetry, mapped to the platform's own outcome and cause.
      synthesis.options.report?.({ outcome: "committed", durationMs: 12, changeCount: 3 });
      assert.deepEqual(reports, [{ outcome: "ok", durationMs: 12, itemCount: 3 }]);
    } finally {
      synthesis.dispose();
      assert.equal(slateRoot.length > 0, true);
    }
    // The schedules themselves are the platform's constants.
    assert.deepEqual([MEMORY_SYNTHESIS_DEBOUNCE_MS, MEMORY_SYNTHESIS_DEADLINE_MS, MEMORY_SYNTHESIS_POLL_INTERVAL_MS, MEMORY_SYNTHESIS_RETRY_ATTEMPTS, MEMORY_SYNTHESIS_RETRY_INITIAL_MS, MEMORY_SYNTHESIS_RETRY_MAX_MS], [15_000, 90_000, 3_600_000, 3, 2_000, 30_000]);
  });
});
