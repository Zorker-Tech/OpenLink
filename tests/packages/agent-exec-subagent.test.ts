import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createContext } from "../../source/packages/context/context.ts";
import {
  RUNNING_SUBAGENT_FOLLOWUP_ERROR,
  RUNNING_SUBAGENT_INTERRUPT_RETRY_HINT,
  createSubagentExecutor,
} from "../../source/packages/agent-exec/subagent.ts";
import type { SubagentArgs } from "../../source/packages/proto/generated/agent/v1/subagent_exec_pb.ts";

const ctx = createContext();
const argsFor = (overrides: Record<string, unknown> = {}) => ({ toolCallId: "call-1", parentConversationId: "parent-1", ...overrides }) as unknown as SubagentArgs;
function fakeAdapter(outcome: unknown = { status: "success", finalMessage: "done", toolCallCount: 2 }) {
  const calls: unknown[] = [];
  const adapter = {
    async createOrResumeSession(_ctx: unknown, args: SubagentArgs) { calls.push(["create", args.toolCallId]); return "agent-1"; },
    async runSession(_ctx: unknown, agentId: string, _args: SubagentArgs, options: unknown) { calls.push(["run", agentId, options]); if (outcome instanceof Error) throw outcome; return outcome; },
    releaseSession(agentId: string) { calls.push(["release", agentId]); },
  };
  return { adapter, calls };
}
const valueOf = (result: any) => result.result.value;

describe("the subagent executor", () => {
  it("words the two running-state messages once", () => {
    assert.equal(RUNNING_SUBAGENT_FOLLOWUP_ERROR.includes("currently running"), true);
    assert.equal(RUNNING_SUBAGENT_INTERRUPT_RETRY_HINT.includes("interrupt"), true);
  });

  it("returns a successful run", async () => {
    const world = fakeAdapter();
    const executor = createSubagentExecutor(world.adapter as never);
    const result = await executor.execute(ctx, argsFor(), { execId: "exec-1" });
    assert.equal(result.result.case, "success");
    const value = valueOf(result);
    assert.equal(value.agentId, "agent-1");
    assert.equal(value.finalMessage, "done");
    assert.equal(value.toolCallCount, 2);
    assert.deepEqual(world.calls[1], ["run", "agent-1", { execId: "exec-1" }]);
  });

  it("turns a failed or aborted run into an error result", async () => {
    const failed = fakeAdapter({ status: "error", error: "it broke" });
    const failedResult = await createSubagentExecutor(failed.adapter as never).execute(ctx, argsFor());
    assert.equal(failedResult.result.case, "error");
    assert.equal(valueOf(failedResult).error, "it broke");
    assert.equal(valueOf(failedResult).agentId, "agent-1");
    const aborted = fakeAdapter({ status: "aborted" });
    const abortedResult = await createSubagentExecutor(aborted.adapter as never).execute(ctx, argsFor());
    assert.equal(valueOf(abortedResult).error, "Subagent was aborted by the user");
  });

  it("returns a background run with its reason and transcript", async () => {
    const world = fakeAdapter({ status: "background", finalMessage: "later", toolCallCount: 3, backgroundReason: 1, transcriptPath: "/tmp/t" });
    const result = await createSubagentExecutor(world.adapter as never).execute(ctx, argsFor());
    assert.equal(result.result.case, "success");
    const value = valueOf(result);
    assert.equal(value.backgroundReason, 1);
    assert.equal(value.transcriptPath, "/tmp/t");
  });

  it("releases the session and reports a thrown failure", async () => {
    const failure = Object.assign(new Error("boom"), { agentId: "agent-9" });
    const world = fakeAdapter(failure);
    const result = await createSubagentExecutor(world.adapter as never).execute(ctx, argsFor());
    assert.equal(result.result.case, "error");
    assert.equal(valueOf(result).error, "boom");
    assert.equal(valueOf(result).agentId, "agent-1");
    assert.deepEqual(world.calls.at(-1), ["release", "agent-1"]);
    const createFailure = Object.assign(new Error("cannot create"), { agentId: "agent-9" });
    const failingCreate = {
      async createOrResumeSession() { throw createFailure; },
      async runSession() { return { status: "success" }; },
    };
    const fallback = await createSubagentExecutor(failingCreate as never).execute(ctx, argsFor());
    assert.equal(valueOf(fallback).agentId, "agent-9");
    assert.equal(valueOf(fallback).error, "cannot create");
  });

  it("does not keep a failed run in flight for the next attempt", async () => {
    const calls: string[] = [];
    const adapter = {
      async createOrResumeSession() { calls.push("create"); return "agent-1"; },
      async runSession() { calls.push("run"); return { status: "error", error: "failed" }; },
    };
    const executor = createSubagentExecutor(adapter as never);
    const first = await executor.execute(ctx, argsFor(), {});
    assert.equal(valueOf(first).error, "failed");
    const second = await executor.execute(ctx, argsFor(), {});
    assert.equal(valueOf(second).error, "failed");
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
    await first;
    assert.equal(calls.length, 1);
    const third = executor.execute(ctx, argsFor(), {});
    assert.notEqual(third, first);
    const cached = await third;
    assert.equal(valueOf(cached).finalMessage, "done");
    assert.equal(calls.length, 1);
    const other = await executor.execute(ctx, argsFor({ toolCallId: "call-2" }), {});
    assert.equal(valueOf(other).finalMessage, "done");
    assert.equal(calls.length, 2);
  });
});
