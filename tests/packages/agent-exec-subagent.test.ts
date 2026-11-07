import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createContext } from "../../source/packages/context/context.ts";
import {
  RUNNING_SUBAGENT_FOLLOWUP_ERROR,
  RUNNING_SUBAGENT_INTERRUPT_RETRY_HINT,
  createSubagentExecutor,
  createUnrecognizedSubagentBackgroundReason,
  type SubagentExecutionArgs,
} from "../../source/packages/agent-exec/subagent.ts";

const ctx = createContext();
const argsFor = (overrides: Partial<SubagentExecutionArgs> = {}): SubagentExecutionArgs => ({ toolCallId: "call-1", parentConversationId: "parent-1", ...overrides });
function fakeAdapter(outcome: unknown = { status: "success", finalMessage: "done", toolCallCount: 2 }) {
  const calls: unknown[] = [];
  const adapter = {
    async createOrResumeSession(_ctx: unknown, args: SubagentExecutionArgs) { calls.push(["create", args.toolCallId]); return "agent-1"; },
    async runSession(_ctx: unknown, agentId: string, _args: SubagentExecutionArgs, options: unknown) { calls.push(["run", agentId, options]); if (outcome instanceof Error) throw outcome; return outcome; },
    releaseSession(agentId: string) { calls.push(["release", agentId]); },
  };
  return { adapter, calls };
}

describe("the subagent executor", () => {
  it("words the two running-state messages once", () => {
    assert.equal(RUNNING_SUBAGENT_FOLLOWUP_ERROR.includes("currently running"), true);
    assert.equal(RUNNING_SUBAGENT_INTERRUPT_RETRY_HINT.includes("interrupt"), true);
  });

  it("returns a successful run", async () => {
    const world = fakeAdapter();
    const executor = createSubagentExecutor(world.adapter as never);
    const result = await executor.execute(ctx, argsFor(), { execId: "exec-1" });
    assert.equal(result.status, "success");
    assert.equal(result.agentId, "agent-1");
    assert.equal(result.finalMessage, "done");
    assert.equal(result.toolCallCount, 2);
    assert.deepEqual(world.calls[1], ["run", "agent-1", { execId: "exec-1" }]);
  });

  it("turns a failed or aborted run into an error result", async () => {
    const failed = fakeAdapter({ status: "error", error: "it broke" });
    const failedResult = await createSubagentExecutor(failed.adapter as never).execute(ctx, argsFor());
    assert.equal(failedResult.status, "error");
    assert.equal(failedResult.error, "it broke");
    assert.equal(failedResult.agentId, "agent-1");
    const aborted = fakeAdapter({ status: "aborted" });
    const abortedResult = await createSubagentExecutor(aborted.adapter as never).execute(ctx, argsFor());
    assert.equal(abortedResult.status, "error");
    assert.equal(abortedResult.error, "Subagent was aborted by the user");
  });

  it("returns a background run with its reason and transcript", async () => {
    const world = fakeAdapter({ status: "background", finalMessage: "later", toolCallCount: 3, backgroundReason: "agent_request", transcriptPath: "/tmp/t" });
    const result = await createSubagentExecutor(world.adapter as never).execute(ctx, argsFor());
    assert.equal(result.status, "success");
    assert.equal(result.backgroundReason, "agent-request");
    assert.equal(result.transcriptPath, "/tmp/t");
  });

  it("normalizes historical reason labels while retaining unknown reason codes as compatibility data", async () => {
    const historical = fakeAdapter({
      status: "background",
      backgroundReason: "unknown-73",
    });
    const result = await createSubagentExecutor(historical.adapter as never).execute(ctx, argsFor());
    assert.equal(result.status, "success");
    if (result.status !== "success") assert.fail("expected a successful background result");
    assert.deepEqual(result.backgroundReason, createUnrecognizedSubagentBackgroundReason(73));

    const sourceReason = createUnrecognizedSubagentBackgroundReason(74)
    const structured = fakeAdapter({ status: "background", backgroundReason: sourceReason });
    const structuredResult = await createSubagentExecutor(structured.adapter as never).execute(ctx, argsFor());
    assert.equal(structuredResult.status, "success");
    if (structuredResult.status !== "success") assert.fail("expected a successful background result");
    assert.notEqual(structuredResult.backgroundReason, sourceReason);
    assert.deepEqual(structuredResult.backgroundReason, sourceReason);
  });

  it("releases the session and reports a thrown failure", async () => {
    const failure = Object.assign(new Error("boom"), { agentId: "agent-9" });
    const world = fakeAdapter(failure);
    const result = await createSubagentExecutor(world.adapter as never).execute(ctx, argsFor());
    assert.equal(result.status, "error");
    assert.equal(result.error, "boom");
    assert.equal(result.agentId, "agent-1");
    assert.deepEqual(world.calls.at(-1), ["release", "agent-1"]);
    const createFailure = Object.assign(new Error("cannot create"), { agentId: "agent-9" });
    const failingCreate = {
      async createOrResumeSession() { throw createFailure; },
      async runSession() { return { status: "success" }; },
    };
    const fallback = await createSubagentExecutor(failingCreate as never).execute(ctx, argsFor());
    assert.equal(fallback.status, "error");
    assert.equal(fallback.agentId, "agent-9");
    assert.equal(fallback.error, "cannot create");
  });

  it("does not keep a failed run in flight for the next attempt", async () => {
    const calls: string[] = [];
    const adapter = {
      async createOrResumeSession() { calls.push("create"); return "agent-1"; },
      async runSession() { calls.push("run"); return { status: "error", error: "failed" }; },
    };
    const executor = createSubagentExecutor(adapter as never);
    const first = await executor.execute(ctx, argsFor(), {});
    assert.equal(first.status, "error");
    assert.equal(first.error, "failed");
    const second = await executor.execute(ctx, argsFor(), {});
    assert.equal(second.status, "error");
    assert.equal(second.error, "failed");
    assert.equal(calls.filter((value) => value === "create").length, 2);
    assert.equal(calls.filter((value) => value === "run").length, 2);
  });

  it("coalesces concurrent calls and caches the completed result", async () => {
    let release: (value: unknown) => void = () => {};
    const gate = new Promise((resolve) => { release = resolve; });
    const calls: unknown[] = [];
    const adapter = {
      async createOrResumeSession() { return "agent-1"; },
      async runSession() { calls.push("run"); await gate; return { status: "success", finalMessage: "done", toolCallCount: 1 }; },
    };
    const executor = createSubagentExecutor(adapter as never);
    const first = executor.execute(ctx, argsFor(), {});
    const second = executor.execute(ctx, argsFor(), {});
    assert.equal(first, second);
    release(undefined);
    const firstResult = await first;
    assert.equal(firstResult.status, "success");
    assert.equal(calls.length, 1);
    const third = executor.execute(ctx, argsFor(), {});
    assert.notEqual(third, first);
    const cached = await third;
    assert.equal(cached.status, "success");
    assert.equal(cached.finalMessage, "done");
    assert.equal(calls.length, 1);
    const other = await executor.execute(ctx, argsFor({ toolCallId: "call-2" }), {});
    assert.equal(other.status, "success");
    assert.equal(other.finalMessage, "done");
    assert.equal(calls.length, 2);
  });
});
