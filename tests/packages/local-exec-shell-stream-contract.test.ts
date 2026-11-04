import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ShellHookApprovalRequirement, ShellHookApprovalRequirement_Kind } from "../../source/adapters/interop/proto/generated/agent/v1/shell_exec_pb.ts";
import { createContext } from "../../source/packages/context/context.ts";
import type { ShellOutputLocation } from "../../source/packages/local-exec/shell-core.ts";
import { LocalShellStreamExecutor } from "../../source/packages/local-exec/shell-stream.ts";
import { SandboxUnsupportedError } from "../../source/packages/shell-exec/sandbox/errors.ts";

type CoreEvent =
  | { type: "stdout" | "stderr"; data: string }
  | { type: "stdin_ready"; stdin: NodeJS.WritableStream | undefined; pid: number | undefined }
  | { type: "exit"; code: number | null; aborted: boolean; outputLocation?: ShellOutputLocation; localExecutionTimeMs: number };

interface RecordedCall {
  context?: unknown;
  command?: string;
  options?: Record<string, unknown>;
  policy?: unknown;
}

interface ShellHarness {
  executor: LocalShellStreamExecutor;
  calls: {
    order: string[];
    invariant: RecordedCall[];
    approval: RecordedCall[];
    core: Array<Record<string, unknown>>;
    ignoreReads: number;
    generatedIds: number;
    adopted: Array<Record<string, unknown>>;
  };
}

function shellHarness(options: {
  invariant?: (call: RecordedCall) => unknown;
  approval?: (call: RecordedCall) => unknown;
  events?: () => AsyncIterable<CoreEvent>;
  cwd?: string;
  ignoreMapping?: unknown;
} = {}): ShellHarness {
  const calls: ShellHarness["calls"] = {
    order: [], invariant: [], approval: [], core: [], ignoreReads: 0, generatedIds: 0, adopted: [],
  };
  const permissions = {
    async shouldEnforceShellInvariantBlocks(context: unknown, request: Record<string, unknown>, policy: unknown) {
      const call = { context, options: request, policy };
      calls.order.push("invariant");
      calls.invariant.push(call);
      return options.invariant?.(call) ?? { kind: "allow" };
    },
    async shouldBlockShellCommand(context: unknown, command: string, request: Record<string, unknown>, policy: unknown) {
      const call = { context, command, options: request, policy };
      calls.order.push("approval");
      calls.approval.push(call);
      return options.approval?.(call) ?? { kind: "allow", policy };
    },
  };
  const core = {
    async getCwd() { return options.cwd ?? "/repo"; },
    execute(_context: unknown, args: Record<string, unknown>) {
      calls.order.push("execute");
      calls.core.push(args);
      if (options.events !== undefined) return options.events();
      return (async function* () {
        yield { type: "stdout", data: "out" } satisfies CoreEvent;
        yield { type: "stderr", data: "warning" } satisfies CoreEvent;
        yield { type: "stdin_ready", stdin: undefined, pid: 73 } satisfies CoreEvent;
        yield {
          type: "exit", code: 7, aborted: false,
          outputLocation: { filePath: "/repo/.tools/output.txt", sizeBytes: 12n, lineCount: 2n },
          localExecutionTimeMs: 19,
        } satisfies CoreEvent;
      })();
    },
  };
  const ignore = {
    async getWorkspaceIgnoreMapping() {
      calls.ignoreReads += 1;
      return options.ignoreMapping ?? { "workspace.ignore": ["generated/**"] };
    },
  };
  const background = {
    generateShellId() { calls.generatedIds += 1; return 41; },
    async adopt(state: Record<string, unknown>) { calls.adopted.push(state); },
    abort() { return true; },
  };
  return {
    executor: new LocalShellStreamExecutor(permissions as never, core as never, ignore as never, background as never),
    calls,
  };
}

async function collect(executor: LocalShellStreamExecutor, command = "printf hello", args: Record<string, unknown> = {}) {
  const stream = executor.execute(createContext(), { command, ...args } as never);
  const events = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe("local shell stream contract", () => {
  it("emits the start, output, and exit events in the order the shell produces them", async () => {
    const h = shellHarness();
    const events = await collect(h.executor, "printf hello", { workingDirectory: "/repo/app" });
    assert.deepEqual(events.map(event => event.type), ["start", "stdout", "stderr", "exit"]);
    assert.equal(events[1]?.type === "stdout" ? events[1].data : undefined, "out");
    assert.equal(events[2]?.type === "stderr" ? events[2].data : undefined, "warning");
    assert.equal(events[3]?.type === "exit" ? events[3].code : undefined, 7);
    assert.equal(events[3]?.type === "exit" ? events[3].cwd : undefined, "/repo");
    assert.equal(events[3]?.type === "exit" ? events[3].outputLocation?.filePath : undefined, "/repo/.tools/output.txt");
    assert.deepEqual(events[3]?.type === "exit" ? events[3].outputLocation : undefined, { filePath: "/repo/.tools/output.txt", sizeBytes: 12n, lineCount: 2n });
    assert.deepEqual(h.calls.order, ["invariant", "approval", "execute"]);
  });

  it("does not start command execution until the consumer advances past the start event", async () => {
    const h = shellHarness();
    const stream = h.executor.execute(createContext(), { command: "echo hello" });
    const iterator = stream[Symbol.asyncIterator]();
    const first = await iterator.next();
    assert.equal(first.value?.type, "start");
    assert.equal(h.calls.core.length, 0);
    await iterator.return?.();
  });

  it("resolves the default directory and forwards command-scoped options to the core", async () => {
    const h = shellHarness({ cwd: "/workspace/project" });
    await collect(h.executor, "echo scoped", {
      toolCallId: "tool-7", conversationId: "conversation-3", fileOutputThresholdBytes: 512,
    });
    assert.equal(h.calls.core[0]?.workingDirectory, "/workspace/project");
    assert.equal(h.calls.core[0]?.conversationId, "conversation-3");
    assert.equal(h.calls.core[0]?.fileOutputThresholdBytes, 512);
    assert.ok(h.calls.core[0]?.signal instanceof AbortSignal);
  });

  it("checks an invariant before asking for command approval", async () => {
    const h = shellHarness();
    await collect(h.executor);
    assert.deepEqual(h.calls.order.slice(0, 2), ["invariant", "approval"]);
    assert.equal(h.calls.invariant[0]?.options?.skipUnsafeWorkingDirectoryBlock, true);
  });

  it("refuses a denylisted command before querying permissions or starting a process", async () => {
    const h = shellHarness();
    const events = await collect(h.executor, "npm install package", { adminCommandDenylist: ["npm:install *"] });
    assert.deepEqual(events.map(event => event.type), ["rejected"]);
    assert.match(events[0]?.type === "rejected" ? events[0].reason : "", /denylist rule/);
    assert.equal(h.calls.invariant.length, 0);
    assert.equal(h.calls.approval.length, 0);
    assert.equal(h.calls.core.length, 0);
  });

  it("returns read-only denials from either permission gate without executing", async () => {
    const h = shellHarness({
      invariant: () => ({ kind: "block", reason: { type: "permissionConfiguration", isReadOnly: true } }),
    });
    const events = await collect(h.executor, "rm -rf /tmp/example");
    assert.deepEqual(events.map(event => event.type), ["permissionDenied"]);
    assert.equal(events[0]?.type === "permissionDenied" ? events[0].isReadonly : undefined, true);
    assert.equal(h.calls.approval.length, 0);
    assert.equal(h.calls.core.length, 0);
  });

  it("carries classifier, smart approval, and hook requirements into the approval decision", async () => {
    const requirement = new ShellHookApprovalRequirement({ kind: ShellHookApprovalRequirement_Kind.FORCE_PROMPT, reason: "policy hook" });
    const h = shellHarness({ approval: () => ({ kind: "block", reason: { type: "unsafeWorkingDirectory", message: "not approved" } }) });
    const classifierResult = { decision: "ask" };
    const events = await collect(h.executor, "echo guarded", {
      toolCallId: "tool-11", classifierResult, smartModeApproval: { reason: "review", requestId: "request-4" }, hookApprovalRequirement: requirement,
    });
    assert.deepEqual(events.map(event => event.type), ["rejected"]);
    assert.equal(h.calls.approval[0]?.options?.toolCallId, "tool-11");
    assert.equal(h.calls.approval[0]?.options?.classifierResult, classifierResult);
    assert.equal(h.calls.approval[0]?.options?.smartModeApprovalReason, "review");
    assert.equal(h.calls.approval[0]?.options?.smartModeApprovalRequestId, "request-4");
    assert.equal(h.calls.approval[0]?.options?.hookApprovalRequirement, requirement);
    assert.equal(h.calls.core.length, 0);
  });

  it("skips the approval classifier when the caller already has approval", async () => {
    const h = shellHarness({ approval: () => ({ kind: "block", reason: { type: "approvalRequired" } }) });
    const events = await collect(h.executor, "echo approved", { skipApproval: true });
    assert.equal(h.calls.invariant.length, 1);
    assert.equal(h.calls.approval.length, 0);
    assert.equal(events[0]?.type, "start");
  });

  it("loads ignore mappings for a requested workspace sandbox and includes that policy in the start event", async () => {
    const h = shellHarness({ ignoreMapping: { patterns: ["build/**"] } });
    const policy = { type: "workspace_readwrite" as const };
    const events = await collect(h.executor, "echo sandboxed", { requestedSandboxPolicy: policy });
    assert.equal(h.calls.ignoreReads, 1);
    const sandbox = h.calls.core[0]?.sandboxPolicy as { perRepo?: { type?: string; ignoreMapping?: unknown } } | undefined;
    assert.equal(sandbox?.perRepo?.type, "workspace_readwrite");
    assert.deepEqual(sandbox?.perRepo?.ignoreMapping, { patterns: ["build/**"] });
    assert.equal(events[0]?.type === "start" ? events[0].policy?.type : undefined, "workspace_readwrite");
  });

  it("does not fetch an ignore mapping for the unrestricted policy", async () => {
    const h = shellHarness();
    await collect(h.executor, "echo unconfined", { requestedSandboxPolicy: { type: "insecure_none" as const } });
    assert.equal(h.calls.ignoreReads, 0);
  });

  it("turns unsupported sandbox execution into a typed stream event", async () => {
    const h = shellHarness({ events: async function* () { throw new SandboxUnsupportedError("sandbox unavailable", "runner missing"); } });
    const events = await collect(h.executor, "echo confined", { requestedSandboxPolicy: { type: "workspace_readonly" as const } });
    assert.deepEqual(events.map(event => event.type), ["start", "sandboxUnsupported"]);
    assert.equal(events[1]?.type === "sandboxUnsupported" ? events[1].reason : undefined, "runner missing");
  });

  it("propagates ordinary core failures and removes their active foreground registration", async () => {
    const h = shellHarness({ events: async function* () { throw new Error("core failed"); } });
    await assert.rejects(collect(h.executor, "echo fail", { toolCallId: "call-fail" }), /core failed/);
    assert.equal((await h.executor.forceBackgroundByToolCallId("call-fail")).status, "not_found");
  });

  it("keeps a foreground command interruptible and transfers its pending output to the background owner", async () => {
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const h = shellHarness({ events: async function* () {
      yield { type: "stdout", data: "before handoff" };
      await pending;
      yield { type: "stdout", data: "after handoff" };
    } });
    const iterator = h.executor.execute(createContext(), { command: "tail -f output", toolCallId: "call-12", timeoutBehavior: "background", timeout: 5_000 })[Symbol.asyncIterator]();
    assert.equal((await iterator.next()).value?.type, "start");
    assert.equal((await iterator.next()).value?.type, "stdout");
    const waiting = iterator.next();
    const accepted = await h.executor.forceBackgroundByToolCallId("call-12");
    assert.equal(accepted.status, "accepted");
    assert.equal(accepted.status === "accepted" ? accepted.shellResult.backgroundReason : undefined, "user");
    const backgrounded = await waiting;
    assert.equal(backgrounded.value?.type, "backgrounded");
    assert.equal(backgrounded.value?.type === "backgrounded" ? backgrounded.value.reason : undefined, "user");
    assert.equal(h.calls.adopted.length, 1);
    assert.equal(h.calls.adopted[0]?.initialOutput, "before handoff");
    release();
    await iterator.return?.();
  });

  it("moves a timed-out backgroundable command into the background with a timeout reason", async () => {
    const h = shellHarness({ events: async function* () { await new Promise<void>(() => {}); } });
    const events = await collect(h.executor, "long-running", { timeout: 5, timeoutBehavior: "background", isBackground: true });
    const last = events.at(-1);
    assert.equal(last?.type, "backgrounded");
    assert.equal(last?.type === "backgrounded" ? last.reason : undefined, "timeout");
    assert.equal(h.calls.adopted.length, 1);
    assert.equal(h.calls.adopted[0]?.initialOutput, "");
  });

  it("refuses an already-cancelled context before invoking permissions or the shell core", async () => {
    const h = shellHarness();
    const [context, cancel] = createContext().withCancel();
    cancel("no longer needed");
    await assert.rejects(async () => {
      for await (const _event of h.executor.execute(context, { command: "echo no" })) { /* consume */ }
    }, /no longer needed/);
    assert.equal(h.calls.invariant.length, 0);
    assert.equal(h.calls.core.length, 0);
  });
});
