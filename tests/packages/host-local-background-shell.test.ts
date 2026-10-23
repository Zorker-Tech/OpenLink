/**
 * Starting a shell that outlives the command: the core factory's readiness/exit handling, adoption, and every result the
 * local executor can return (denylist, permission refusal, blocked command, success, sandbox unavailable, generic error).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CoreShellFactory,
  LocalBackgroundShellExecutor,
  type BackgroundPermissions,
} from "../../source/packages/local-exec/background-shell.ts";
import { SandboxUnsupportedError } from "../../source/packages/shell-exec/sandbox/errors.ts";

const stdinReady = (stdin: unknown = { write: () => undefined }, pid = 42) => ({ type: "stdin_ready", stdin, pid });
const exitEvent = (code: number | null, aborted = false, outputLocation?: { filePath: string }) => ({ type: "exit", code, aborted, ...(outputLocation === undefined ? {} : { outputLocation }) });
const events = (list: unknown[]) => (async function* () { for (const event of list) yield event; })();
const ctx = {} as never;

function coreExecutor(list: unknown[]) {
  const calls: unknown[] = [];
  return {
    calls,
    executor: { execute(_ctx: unknown, args: unknown) { calls.push(args); return events(list); } },
  };
}

function fakeFactory(behaviour: string) {
  const calls: unknown[] = [];
  return {
    calls,
    factory: {
      async spawn(context: unknown, core: unknown) {
        calls.push({ context, core });
        if (behaviour === "sandbox") throw new SandboxUnsupportedError("forced sandbox refused", "insecure_none");
        if (behaviour === "error") throw new Error("spawn failed");
        if (behaviour === "stringError") throw "spawn failed as a string";
        return { id: 7, pid: 43, signal: new AbortController().signal, onComplete: () => undefined };
      },
      async adopt() { return { shellId: 8, pid: 44 }; },
    },
  };
}

function permissions(block: string | undefined) {
  const calls: unknown[] = [];
  const impl: BackgroundPermissions = {
    async shouldEnforceShellInvariantBlocks(_ctx, options) { calls.push({ invariant: options }); return block === "permissions" ? { kind: "block", reason: { type: "permissionsConfig", isReadonly: true } } : { kind: "allow", policy: { type: "insecure_none" } as never }; },
    async shouldBlockShellCommand(_ctx, command, options) {
      calls.push({ command, options });
      if (block === "permissions") return { kind: "block", reason: { type: "permissionsConfig", isReadonly: true } };
      if (block === "rule") return { kind: "block", reason: { type: "commandDenylist", match: "rm", command: "rm -rf /" } as never };
      return { kind: "allow", policy: { type: "workspace_readwrite" } as never };
    },
  };
  return { calls, impl };
}

function localExecutor(block: string | undefined, factoryBehaviour = "ok") {
  const factory = fakeFactory(factoryBehaviour);
  const permission = permissions(block);
  const localCore = { async getCwd() { return "/work"; }, execute() { return events([stdinReady(), exitEvent(0)]); } };
  const executor = new LocalBackgroundShellExecutor(permission.impl, localCore as never, { async getCursorIgnoreMapping() { return {}; } } as never, "/repo", factory.factory as never);
  return { executor, factory, permission };
}

test("the core factory waits for readiness and consumes the rest in the background", async () => {
  const ready = coreExecutor([stdinReady(), exitEvent(0)]);
  const factory = new CoreShellFactory();
  const shell = await factory.spawn({ shellId: 3, command: "ls", workingDirectory: "/work", ctx } as never, ready.executor as never);
  assert.equal(shell.pid, 42);
  assert.equal(typeof shell.stdin?.write, "function");
  assert.equal(ready.calls.length, 1);
  assert.deepEqual((ready.calls[0] as Record<string, unknown>).command, "ls");
  assert.equal((ready.calls[0] as Record<string, unknown>).workingDirectory, "/work");
  assert.equal((ready.calls[0] as Record<string, unknown>).showElapsedTime, true);
});

test("the core factory passes the optional call context through", async () => {
  const ready = coreExecutor([stdinReady(), exitEvent(0)]);
  const factory = new CoreShellFactory();
  await factory.spawn({ shellId: 4, command: "sleep 2", workingDirectory: "/work", ctx, toolCallId: "call-1", conversationId: "conv-1", sandboxPolicy: { type: 1 }, enableWriteShellStdinTool: true } as never, ready.executor as never);
  const call = ready.calls[0] as Record<string, unknown>;
  assert.equal(call.toolCallId, "call-1");
  assert.equal(call.conversationId, "conv-1");
  assert.equal(call.pipeStdin, true);
  assert.notEqual(call.sandboxPolicy, undefined);
});

test("the core factory refuses a missing executor and rethrows a sandbox refusal", async () => {
  const factory = new CoreShellFactory();
  await assert.rejects(() => factory.spawn({ shellId: 5, command: "ls", workingDirectory: "/w", ctx } as never, {} as never), /Background shell core executor is not configured/);
  await assert.rejects(
    () => factory.spawn({ shellId: 5, command: "ls", workingDirectory: "/w", ctx } as never, { execute() { return (async function* () { throw new SandboxUnsupportedError("no sandbox", "insecure_none"); })(); } } as never),
    (error: unknown) => error instanceof SandboxUnsupportedError,
  );
});

test("the core factory keeps the shell when the foreground stream fails for another reason", async () => {
  const factory = new CoreShellFactory();
  const shell = await factory.spawn({ shellId: 6, command: "ls", workingDirectory: "/w", ctx } as never, { execute() { return (async function* () { throw new Error("boom"); })(); } } as never);
  assert.equal(shell.pid, undefined);
});

test("an adopted shell is wired to its own event stream", async () => {
  const factory = new CoreShellFactory();
  const shell = await factory.adopt({ shellId: 9, abortController: new AbortController(), stdin: { write: () => undefined }, pid: 50, eventIterator: events([stdinReady(), exitEvent(0)]) } as never);
  assert.equal(shell.pid, 50);
  assert.equal(typeof shell.stdin?.write, "function");
});

test("a denied-by-model command is rejected before any permission check", async () => {
  const world = localExecutor(undefined);
  const result = await world.executor.execute(ctx, { command: "echo hi", adminCommandDenylist: ["echo"] });
  assert.equal(result.result.case, "rejected");
  assert.equal(world.permission.calls.length, 0);
});

test("a permission refusal is reported as a permission denial", async () => {
  const world = localExecutor("permissions");
  const result = await world.executor.execute(ctx, { command: "rm -rf /" });
  assert.equal(result.result.case, "permissionDenied");
  assert.equal((result.result as { value: { error: string } }).value.error, "Command blocked by permissions configuration");
});

test("a skipped approval asks the invariant check instead of the full check", async () => {
  const world = localExecutor(undefined);
  const result = await world.executor.execute(ctx, { command: "rm -rf /", skipApproval: true });
  assert.equal(result.result.case, "success");
  assert.equal((world.permission.calls[0] as { invariant?: unknown }).invariant !== undefined, true);
});

test("a rule refusal is a rejected result carrying the block message", async () => {
  const world = localExecutor("rule");
  const result = await world.executor.execute(ctx, { command: "rm -rf /" });
  assert.equal(result.result.case, "rejected");
});

test("a successful spawn answers with the shell id, command and working directory", async () => {
  const world = localExecutor(undefined);
  const result = await world.executor.execute(ctx, { command: "sleep 10", workingDirectory: "/work", toolCallId: "call-1", conversationId: "conv-1", enableWriteShellStdinTool: true, description: "sleeps" });
  assert.equal(result.result.case, "success");
  const value = (result.result as { value: { shellId: number; command: string; workingDirectory: string; pid?: number } }).value;
  assert.equal(value.command, "sleep 10");
  assert.equal(value.workingDirectory, "/work");
  assert.equal(value.pid, 43);
  assert.equal(typeof value.shellId, "number");
  assert.equal(world.factory.calls.length, 1);
});

test("a missing working directory comes from the core", async () => {
  const world = localExecutor(undefined);
  const result = await world.executor.execute(ctx, { command: "sleep 10" });
  assert.equal((result.result as { value: { workingDirectory: string } }).value.workingDirectory, "/work");
});

test("a sandbox refusal at spawn is a sandboxUnsupported result", async () => {
  const world = localExecutor(undefined, "sandbox");
  const result = await world.executor.execute(ctx, { command: "sleep 10" });
  assert.equal(result.result.case, "sandboxUnsupported");
  const value = (result.result as { value: { sandboxPolicyType: string; isReadonly: boolean } }).value;
  assert.equal(value.sandboxPolicyType, "workspace_readwrite");
  assert.equal(value.isReadonly, false);
});

test("any other spawn failure is an error result", async () => {
  const world = localExecutor(undefined, "error");
  const result = await world.executor.execute(ctx, { command: "sleep 10" });
  assert.equal(result.result.case, "error");
  assert.equal((result.result as { value: { error: string } }).value.error, "spawn failed");
});

test("the executor exposes its manager and can be disposed", () => {
  const world = localExecutor(undefined);
  assert.equal(typeof world.executor.getManager(), "object");
  assert.equal(typeof world.executor.writeStdin, "function");
  assert.equal(world.executor.dispose(), undefined);
});

test("the spawned shell carries every optional call field", async () => {
  const world = localExecutor(undefined);
  await world.executor.execute(ctx, { command: "sleep 10", workingDirectory: "/work", toolCallId: "call-1", conversationId: "conv-1", enableWriteShellStdinTool: true, description: "sleeps", outputNotification: { notify: true } });
  const context = (world.factory.calls[0] as { context: Record<string, unknown> }).context;
  assert.equal(context.toolCallId, "call-1");
  assert.equal(context.conversationId, "conv-1");
  assert.equal(context.enableWriteShellStdinTool, true);
  assert.equal(context.description, "sleeps");
  assert.deepEqual(context.outputNotification, { notify: true });
  assert.deepEqual(context.sandboxPolicy, { perRepo: { type: "workspace_readwrite" } });
});

test("the skipped-approval check is told to skip the unsafe directory block", async () => {
  const world = localExecutor(undefined);
  await world.executor.execute(ctx, { command: "rm -rf /", skipApproval: true });
  assert.equal((world.permission.calls[0] as { invariant: { skipUnsafeWorkingDirectoryBlock: boolean } }).invariant.skipUnsafeWorkingDirectoryBlock, true);
});

test("the full check is given the parsed command including redirects", async () => {
  const world = localExecutor(undefined);
  await world.executor.execute(ctx, { command: "echo hi > /tmp/out" });
  const options = (world.permission.calls[0] as { options: { parsingResult: { toJson(): Record<string, unknown> } } }).options;
  const parsed = options.parsingResult.toJson() as { hasRedirects: boolean; redirects: Array<{ targetText?: string }> };
  assert.equal(parsed.hasRedirects, true);
  assert.equal(parsed.redirects[0]?.targetText, "/tmp/out");
});

test("the default factory starts a real shell over the injected core", async () => {
  const permission = permissions(undefined);
  const localCore = { async getCwd() { return "/work"; }, execute() { return events([stdinReady(), exitEvent(0)]); } };
  const dir = await mkdtemp(join(tmpdir(), "background-shell-"));
  const executor = new LocalBackgroundShellExecutor(permission.impl, localCore as never, { async getCursorIgnoreMapping() { return {}; } } as never, dir);
  const result = await executor.execute(ctx, { command: "sleep 10" });
  assert.equal(result.result.case, "success");
  assert.equal((result.result as { value: { pid?: number } }).value.pid, 42);
  executor.dispose();
});

test("the core factory's shell reports its completion after the exit event", async () => {
  const ready = coreExecutor([stdinReady(), exitEvent(3, true, { filePath: "/logs/out.txt" })]);
  const factory = new CoreShellFactory();
  const shell = await factory.spawn({ shellId: 11, command: "ls", workingDirectory: "/w", ctx } as never, ready.executor as never);
  const completion = await new Promise((resolve) => shell.onComplete!(resolve));
  assert.deepEqual(completion, { code: 3, aborted: true, outputPath: "/logs/out.txt" });
});

test("a missing core executor is refused with its exact message", async () => {
  const factory = new CoreShellFactory();
  await assert.rejects(async () => { await factory.spawn({ shellId: 5, command: "ls", workingDirectory: "/w", ctx } as never, {} as never); }, (error: unknown) => (error as Error).message === "Background shell core executor is not configured");
});

test("the parsed command leaves an absent redirect summary out", async () => {
  const world = localExecutor(undefined);
  await world.executor.execute(ctx, { command: "echo hi" });
  const options = (world.permission.calls[0] as { options: { parsingResult: { toJson(): Record<string, unknown> } } }).options;
  const parsed = options.parsingResult.toJson();
  assert.equal("allRedirectsAreDevNull" in parsed, false);
});

test("a failure that is not an error says Unknown error", async () => {
  const world = localExecutor(undefined, "stringError");
  const result = await world.executor.execute(ctx, { command: "sleep 10" });
  assert.equal(result.result.case, "error");
  assert.equal((result.result as { value: { error: string } }).value.error, "Unknown error");
});
