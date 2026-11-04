import { test } from "node:test";
import assert from "node:assert/strict";

import { createContext } from "../../source/packages/context/context.ts";
import { backgroundShellExecutorResource } from "../../source/packages/agent-exec/background-shell.ts";
import { readExecutorResource } from "../../source/packages/agent-exec/read-operation.ts";
import { shellExecutorResource } from "../../source/packages/agent-exec/shell.ts";
import { shellStreamExecutorResource } from "../../source/packages/agent-exec/shell-stream-operation.ts";
import { smartModeClassifierExecutorResource } from "../../source/packages/agent-exec/smart-mode-classifier-operation.ts";
import { computerUseExecutorResource } from "../../source/adapters/interop/agent/computer-use-executor-adapter.ts";
import { executeBoxWindowShellCommand } from "../../source/adapters/interop/agent/box-window-shell-result-adapter.ts";
import { BoxNotReadyError, createRemoteBoxResourceAccessor } from "../../source/host/runner/remote-box-resources.ts";
import { SlateBoxNoMonitorAvailableError, noMonitorComputerUseExecutor } from "../../source/host/ports/box.ts";

type ExecutorPort = {
  execute(context: unknown, args: unknown, options?: unknown): Promise<unknown> | AsyncIterable<unknown>;
};

function world(options: {
  readonly desktop?: boolean;
  readonly preparing?: boolean;
  readonly prepared?: boolean;
  readonly classifier?: unknown;
  readonly modes?: Readonly<Record<string, string>>;
  readonly ready?: () => Promise<unknown>;
  readonly executors?: ReadonlyMap<unknown, ExecutorPort>;
} = {}) {
  const calls: unknown[] = [];
  let terminalsFolder = "";
  const connection = {
    terminalsFolder: "/box/terminals",
    remoteAccessor: {
      get(resource: unknown) {
        const executor = options.executors?.get(resource);
        if (executor === undefined) throw new Error("resource not registered");
        return executor;
      },
    },
  };
  const box = {
    isPreparing: () => options.preparing ?? false,
    getAgentWindowIndex: () => 1,
    async ensureReady() {
      calls.push("ensure-ready");
      return await (options.ready?.() ?? Promise.resolve(connection));
    },
  };
  const host = {
    executeWindowCommand: executeBoxWindowShellCommand,
    remoteBox: box,
    remoteBoxHasDesktop: options.desktop ?? false,
    ...(options.prepared === true ? { preparedRemoteBoxConnection: Promise.resolve(connection) } : {}),
    resolveBoxId: () => "box-1",
    getConversationId: () => "agent-1",
    setRemoteBoxTerminalsFolder(folder: string) { terminalsFolder = folder; calls.push(["terminals", folder]); },
    autoReviewGate: {
      assertNoPendingApproval() { calls.push("guard"); },
      currentModes: () => options.modes ?? {},
    },
    auditShellCommand(agentId: string, kind: string, command: string, target: string, attribution: unknown) {
      calls.push(["audit", agentId, kind, command, target, attribution]);
    },
    computerUse: {
      getOrCreateNavigationProbe: () => ({
        async captureBaseline() { calls.push("baseline"); },
      }),
      recordAuditIntent(actionCase: string | undefined) { calls.push(["intent", actionCase]); },
    },
    probeNavigationAfterComputerUse() { calls.push("probe"); },
    ...(options.classifier === undefined ? {} : { autoReviewClassifierExecutor: options.classifier }),
  };
  return {
    calls,
    get terminalsFolder() { return terminalsFolder; },
    accessor: createRemoteBoxResourceAccessor(host as never),
  };
}

test("shell streams are gated and audited before they reach the remote box", async () => {
  const worlded = world({
    executors: new Map([
      [shellStreamExecutorResource, {
        execute(_context, _args) {
          worlded.calls.push("remote-stream");
          return (async function* () { yield "line"; })();
        },
      }],
    ]),
  });
  const resource = worlded.accessor.get(shellStreamExecutorResource) as unknown as ExecutorPort;
  const output: unknown[] = [];
  const stream = resource.execute(createContext(), { command: "pwd" }) as AsyncIterable<unknown>;
  for await (const item of stream) output.push(item);

  assert.deepEqual(output, ["line"]);
  assert.deepEqual(worlded.calls, [
    "guard",
    ["audit", "agent-1", "foreground", "pwd", "box", { boxId: "box-1" }],
    "ensure-ready",
    ["terminals", "/box/terminals"],
    "guard",
    "guard",
    "remote-stream",
  ]);
  assert.equal(worlded.terminalsFolder, "/box/terminals");
});

test("a failed connection is cleared so the next call can recover", async () => {
  let attempts = 0;
  const calls: string[] = [];
  const connection = {
    terminalsFolder: "/box/terminals",
    remoteAccessor: {
      get(resource: unknown) {
        assert.equal(resource, readExecutorResource);
        return { async execute() { calls.push("read"); return { result: { case: "success" } }; } };
      },
    },
  };
  const worlded = world({
    ready: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("control channel closed");
      return connection;
    },
  });
  const read = worlded.accessor.get(readExecutorResource) as unknown as ExecutorPort;

  await assert.rejects(async () => await read.execute(createContext(), { path: "/repo/file" }), BoxNotReadyError);
  await read.execute(createContext(), { path: "/repo/file" });
  assert.equal(attempts, 2);
  assert.deepEqual(calls, ["read"]);
});

test("a prepared connection is used without asking the box again", async () => {
  const worlded = world({
    prepared: true,
    executors: new Map([[readExecutorResource, {
      async execute() { worlded.calls.push("read"); return { result: { case: "success" } }; },
    }]]),
  });
  const read = worlded.accessor.get(readExecutorResource) as unknown as ExecutorPort;

  await read.execute(createContext(), { path: "/repo/file" });
  assert.equal(worlded.calls.includes("ensure-ready"), false);
  assert.deepEqual(worlded.calls, [["terminals", "/box/terminals"], "read"]);
});

test("a box that is still preparing refuses resource access before connecting", async () => {
  const worlded = world({ preparing: true });
  const read = worlded.accessor.get(readExecutorResource) as unknown as ExecutorPort;
  await assert.rejects(async () => await read.execute(createContext(), { path: "/repo/file" }), BoxNotReadyError);
  assert.deepEqual(worlded.calls, []);
});

test("background and foreground shell calls preserve their distinct audit paths", async () => {
  const executors = new Map<unknown, ExecutorPort>();
  executors.set(backgroundShellExecutorResource, {
    async execute(_context, args) { worlded.calls.push(["background", args]); return { result: { case: "success" } }; },
  });
  executors.set(shellExecutorResource, {
    async execute(_context, args) { worlded.calls.push(["shell", args]); return { result: { case: "success" } }; },
  });
  const worlded = world({
    executors,
  });
  const background = worlded.accessor.get(backgroundShellExecutorResource) as unknown as ExecutorPort;
  const shell = worlded.accessor.get(shellExecutorResource) as unknown as ExecutorPort;

  await background.execute(createContext(), { command: "sleep 5" });
  await shell.execute(createContext(), { command: "git status" });
  assert.deepEqual(worlded.calls.filter(call => Array.isArray(call) && call[0] === "audit"), [
    ["audit", "agent-1", "background", "sleep 5", "box", { boxId: "box-1" }],
  ]);
  assert.deepEqual(worlded.calls.filter(call => Array.isArray(call) && ["background", "shell"].includes(String(call[0]))).map(call => (call as unknown[])[0]), [
    "background",
    "shell",
  ]);
  assert.equal(worlded.calls.filter(call => call === "guard").length, 5);
});

test("shell navigation probes run around a streamed command, including a failed stream", async () => {
  const failure = new Error("shell stream ended");
  const executors = new Map<unknown, ExecutorPort>();
  executors.set(computerUseExecutorResource, { async execute() { return { result: { case: "success" } }; } });
  executors.set(shellStreamExecutorResource, {
    execute() {
      return (async function* () {
        worlded.calls.push("remote-stream");
        throw failure;
      })();
    },
  });
  const worlded = world({
    desktop: true,
    executors,
  });
  const stream = worlded.accessor.get(shellStreamExecutorResource) as unknown as ExecutorPort;
  await assert.rejects(async () => {
    for await (const _item of stream.execute(createContext(), { command: "open browser" }) as AsyncIterable<unknown>) {}
  }, failure);
  assert.deepEqual(worlded.calls, [
    "guard",
    ["audit", "agent-1", "foreground", "open browser", "box", { boxId: "box-1" }],
    "ensure-ready",
    ["terminals", "/box/terminals"],
    "guard",
    "baseline",
    "guard",
    "remote-stream",
    "probe",
  ]);
});

test("the classifier resource exists only while a review mode is active", () => {
  const classifier = { execute() {} };
  assert.equal(world({ classifier, modes: { shell: "off", write: "off" } }).accessor.get(smartModeClassifierExecutorResource), undefined);
  assert.equal(world({ classifier, modes: { shell: "on" } }).accessor.get(smartModeClassifierExecutorResource), classifier);
});

test("desktop use records intent after execution and always probes afterward", async () => {
  const executors = new Map<unknown, ExecutorPort>([
    [computerUseExecutorResource, {
      async execute() { worlded.calls.push("computer-use"); return { result: { case: "success" } }; },
    }],
    [shellExecutorResource, {
      async execute(_context, args) {
        worlded.calls.push(["lease", (args as { command?: string }).command]);
        return { result: { case: "success" } };
      },
    }],
  ]);
  const worlded = world({ desktop: true, executors });
  const computer = worlded.accessor.get(computerUseExecutorResource) as unknown as ExecutorPort;

  await computer.execute(createContext(), { actions: [{ action: { case: "click" } }] });
  assert.deepEqual(worlded.calls, [
    "ensure-ready",
    ["terminals", "/box/terminals"],
    "baseline",
    ["lease", "touch /tmp/slate-monitor-busy-1"],
    "guard",
    "computer-use",
    ["intent", "click"],
    "probe",
  ]);
});

test("a box with no available monitor is reported as not ready", async () => {
  const worlded = world({
    desktop: true,
    executors: new Map([[computerUseExecutorResource, noMonitorComputerUseExecutor as unknown as ExecutorPort]]),
  });
  const computer = worlded.accessor.get(computerUseExecutorResource) as unknown as ExecutorPort;
  await assert.rejects(
    async () => await computer.execute(createContext(), { actions: [{ action: { case: "click" } }] }),
    (error: unknown) => {
      assert.equal(error instanceof BoxNotReadyError, true);
      assert.equal((error as Error).cause instanceof SlateBoxNoMonitorAvailableError, true);
      return true;
    },
  );
});

test("reading a file does not go through shell approval or command auditing", async () => {
  const worlded = world({
    executors: new Map([[readExecutorResource, {
      async execute(_context, args) { worlded.calls.push(["read", args]); return { result: { case: "success" } }; },
    }]]),
  });
  const read = worlded.accessor.get(readExecutorResource) as unknown as ExecutorPort;
  await read.execute(createContext(), { path: "/repo/file" });
  assert.equal(worlded.calls.some(call => call === "guard"), false);
  assert.equal(worlded.calls.some(call => Array.isArray(call) && call[0] === "audit"), false);
  assert.equal(worlded.calls.some(call => Array.isArray(call) && call[0] === "read"), true);
});
