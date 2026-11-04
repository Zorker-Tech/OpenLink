import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createHostBrowserDriverDependencies,
  createHostComputerToolDependencies,
  createHostShellExecutor,
} from "../../source/host/runner/host-computer-tool-dependencies.ts";
import { toGeneratedComputerUseArgs } from "../../source/adapters/interop/agent/computer-use-executor-adapter.ts";

const action = (wireCase: string, value: unknown) => ({ action: { case: wireCase, value } });

/** The action cases as the generated protobuf exposes them. */
const describeGenerated = (args: ReturnType<typeof toGeneratedComputerUseArgs>) =>
  args.actions.map(generated => ({ case: generated.action.case, value: generated.action.value }));

describe("protocol actions read as generated actions", () => {
  it("carries every supported action through", () => {
    const args = toGeneratedComputerUseArgs({
      toolCallId: "call-1",
      actions: [
        action("mouseMove", { coordinate: { x: 1, y: 2 } }),
        action("click", { coordinate: { x: 3, y: 4 }, button: "LEFT", count: 2, modifierKeys: "CTRL" }),
        action("mouseDown", { button: "RIGHT" }),
        action("mouseUp", { button: "MIDDLE" }),
        action("drag", { path: [{ x: 0, y: 0 }, { x: 5, y: 6 }], button: "LEFT" }),
        action("scroll", { direction: "DOWN", amount: 3 }),
        action("type", { text: "hello ✓" }),
        action("key", { key: "Enter", holdDurationMs: 0 }),
        action("wait", { durationMs: 250 }),
        action("screenshot", {}),
        action("cursorPosition", {}),
      ] as never,
    });
    assert.equal(args.toolCallId, "call-1");
    assert.equal(args.bindUnmappedCharacters, undefined);
    assert.equal(args.description, undefined);
    assert.deepEqual(args.actions.map(generated => generated.action.case), [
      "mouseMove", "click", "mouseDown", "mouseUp", "drag", "scroll", "type", "key", "wait", "screenshot", "cursorPosition",
    ]);
    const click = describeGenerated(args)[1]?.value as { button: number; count: number; modifierKeys?: string };
    assert.deepEqual([click.button, click.count, click.modifierKeys], [1, 2, "CTRL"]);
    assert.deepEqual((describeGenerated(args)[4]?.value as { path: unknown[] }).path.length, 2);
  });

  it("carries the argument-level optional fields only when they are set", () => {
    const set = toGeneratedComputerUseArgs({ toolCallId: "c", actions: [], bindUnmappedCharacters: true, description: "do it" });
    assert.deepEqual([set.bindUnmappedCharacters, set.description], [true, "do it"]);
    const unset = toGeneratedComputerUseArgs({ toolCallId: "c", actions: [], bindUnmappedCharacters: undefined as never, description: undefined as never });
    assert.deepEqual([unset.bindUnmappedCharacters, unset.description], [undefined, undefined]);
    assert.deepEqual([toGeneratedComputerUseArgs({ toolCallId: "c", actions: [] }).bindUnmappedCharacters], [undefined]);
  });

  it("refuses a payload it cannot read, naming the case", () => {
    const refusals: Array<[string, unknown, RegExp]> = [
      ["no case", { action: { value: {} } }, /computer action has no case/],
      ["missing action", {}, /Cannot read properties of undefined/],
      ["null value", action("click", null), /computer action click has no value/],
      ["array value", action("wait", []), /computer action wait has no value/],
      ["unknown case", action("teleport", {}), /unsupported computer action: teleport$/],
      ["bad coordinate", action("mouseMove", { coordinate: { x: 1 } }), /computer action field coordinate\.y is not numeric/],
      ["non-numeric coordinate", action("mouseMove", { coordinate: { x: "1", y: 2 } }), /coordinate\.x is not numeric/],
      ["NaN coordinate", action("mouseMove", { coordinate: { x: Number.NaN, y: 2 } }), /coordinate\.x is not numeric/],
      ["bad button", action("click", { button: "SIDEWAYS", count: 1 }), /unknown computer action button: SIDEWAYS/],
      ["bad count", action("click", { button: "LEFT", count: "2" }), /computer action field count is not numeric/],
      ["bad modifier keys", action("click", { button: "LEFT", count: 1, modifierKeys: 3 }), /computer action field modifierKeys is not textual/],
      ["drag path not an array", action("drag", { path: "rows", button: "LEFT" }), /computer action drag path is not an array/],
      ["drag point without coordinate", action("drag", { path: [null], button: "LEFT" }), /computer action drag path contains no coordinate/],
      ["bad direction", action("scroll", { direction: "AROUND", amount: 1 }), /unknown computer action direction: AROUND/],
      ["bad duration", action("wait", { durationMs: Number.POSITIVE_INFINITY }), /computer action field durationMs is not numeric/],
    ];
    for (const [label, input, expected] of refusals) {
      assert.throws(() => toGeneratedComputerUseArgs({ toolCallId: "c", actions: [input as never] }), expected, label);
    }
  });

  it("keeps the platform's lookup quirk for inherited names", () => {
    // A name the table does not own but the object prototype has is returned as-is: the shipped behaviour, pinned.
    const quirky = toGeneratedComputerUseArgs({ toolCallId: "c", actions: [action("click", { button: "toString", count: 1 }), action("scroll", { direction: "valueOf", amount: 1 })] as never });
    const generated = describeGenerated(quirky);
    assert.equal(typeof (generated[0]?.value as { button: unknown }).button, "function");
    assert.equal(typeof (generated[1]?.value as { direction: unknown }).direction, "function");
    // A name the table does not own and the prototype does not have is refused with that name.
    assert.throws(() => toGeneratedComputerUseArgs({ toolCallId: "c", actions: [action("click", { button: "SIDEWAYS", count: 1 })] as never }), /unknown computer action button: SIDEWAYS/);
  });
});

describe("the computer tool projection", () => {
  function computerWorld(result: unknown) {
    const calls: unknown[] = [];
    const resourceAccessor = {
      get(resource: unknown) {
        calls.push(["get", resource]);
        return {
          async execute(context: unknown, args: unknown) {
            calls.push(["execute", context, args]);
            if (result instanceof Error) throw result;
            return result;
          },
        };
      },
    };
    return { calls, resourceAccessor };
  }

  it("asks the turn's executor and reads its result back into the host's shape", async () => {
    const world = computerWorld({ result: { case: "success", value: { screenshot: "image", cursorPosition: { x: 4, y: 5 } } } });
    const persistImage = async () => undefined;
    const dependencies = createHostComputerToolDependencies({ resourceAccessor: world.resourceAccessor, persistImage, isUnicodeTypingEnabled: () => true, onComputerAction: () => {}, autoReview: {} } as never) as never as Record<string, unknown>;
    assert.deepEqual(Object.keys(dependencies), ["resourceAccessor", "execute", "getPersistImage", "isUnicodeTypingEnabled", "onComputerAction", "autoReview"]);
    assert.equal(dependencies.resourceAccessor, world.resourceAccessor);
    assert.equal((dependencies.getPersistImage as () => unknown)(), persistImage, "the persist hook is handed back as it was given");
    const outcome = await (dependencies.execute as (context: unknown, args: unknown) => Promise<unknown>)({ user: "c" }, { toolCallId: "c1", actions: [action("wait", { durationMs: 1 })] });
    assert.deepEqual(outcome, { result: { case: "success", value: { screenshot: "image", cursorPosition: { x: 4, y: 5 } } } });
    assert.equal(world.calls.length, 2);
    const executed = world.calls[1] as [string, unknown, { actions: { action: { case: string } }[] }];
    assert.equal(executed[2].actions[0]?.action.case, "wait", "the protocol action was converted before the executor saw it");
    const converted = executed[2].actions[0] as unknown as { action: { value: { constructor: { name: string } } } };
    assert.equal(converted.action.value.constructor.name, "WaitAction", "the executor receives the generated action, not the protocol record");
  });

  it("reads an empty, an error and an unnamed result honestly, and raises a failing executor", async () => {
    const read = (result: unknown) => createHostComputerToolDependencies({ resourceAccessor: computerWorld(result).resourceAccessor } as never) as never as { execute(context: unknown, args: unknown): Promise<unknown> };
    const request = { toolCallId: "c", actions: [] };
    assert.deepEqual(await read({ result: { case: "success", value: {} } }).execute({}, request), { result: { case: "success", value: {} } });
    assert.deepEqual(await read({ result: { case: "error", value: { error: "it broke" } } }).execute({}, request), { result: { case: "error", value: { error: "it broke" } } });
    assert.deepEqual(await read({ result: {} }).execute({}, request), { result: { case: "" } });
    await assert.rejects(() => read(new Error("executor exploded")).execute({}, request), { message: "executor exploded" });
  });
});

describe("the shell executor projection", () => {
  it("runs the approval and the audit before the executor sees the command", async () => {
    const calls: unknown[] = [];
    const guards: unknown[] = [];
    const resourceAccessor = {
      get(resource: unknown) {
        calls.push(["get", resource]);
        return {
          async execute(context: unknown, args: unknown, options: unknown) {
            calls.push(["execute", context, args, options]);
            return { result: { case: "success", value: { stdout: "out", stderr: "err", exitCode: 0 } } };
          },
        };
      },
    };
    const dependencies = createHostShellExecutor({ resourceAccessor, assertNoPendingApproval: () => guards.push("approval"), auditShellCommand: (command: string) => guards.push(["audit", command]) } as never);
    assert.deepEqual(Object.keys(dependencies), ["execute"]);
    const options = { signal: { aborted: false } };
    const result = await dependencies.execute({ user: "c" }, { command: "echo hi", timeoutMs: 1_000, description: "run it" } as never, options as never);
    assert.deepEqual(guards, ["approval", ["audit", "echo hi"]], "both safety callbacks run, approval first");
    assert.deepEqual((result as { result: { case: string } }).result.case, "success");
    const executed = calls[1] as [string, unknown, { command: string }, unknown];
    assert.equal(executed[2].command, "echo hi", "the host shell args were built before the executor saw them");
    assert.equal(executed[3], options, "the abort-bearing options are passed through as given");
  });

  it("raises what the executor raises", async () => {
    const resourceAccessor = { get: () => ({ async execute() { throw new Error("shell exploded"); } }) };
    const dependencies = createHostShellExecutor({ resourceAccessor, assertNoPendingApproval: () => {}, auditShellCommand: () => {} } as never);
    await assert.rejects(() => dependencies.execute({}, { command: "x" } as never), { message: "shell exploded" });
  });
});

describe("the browser driver projection", () => {
  const box = {
    ready: [] as unknown[],
    async ensureReady(context: unknown, agentId: string) { this.ready.push(["ensureReady", agentId]); return "ready"; },
    getAgentWindowIndex(agentId: string) { this.ready.push(["windowIndex", agentId]); return 3; },
    uploaded: [] as unknown[],
    async uploadFile(context: unknown, agentId: string, path: string, bytes: Uint8Array) { this.uploaded.push([agentId, path, bytes]); },
    async downloadFile(context: unknown, agentId: string, path: string) { this.ready.push(["download", agentId, path]); return new Uint8Array([1, 2, 3]); },
  };
  const shell = {
    async execute(context: unknown, input: unknown) { return { result: { case: "success", value: { stdout: "o", stderr: "e", exitCode: 2 } } }; },
  };

  it("checks the box is ready before looking up its window, and passes file transfers through", async () => {
    const dependencies = createHostBrowserDriverDependencies({ resourceAccessor: { get: () => shell }, box, getBoxId: () => "box-1", getDefaultViewId: () => "view-1", executeShell: shell } as never);
    assert.deepEqual(Object.keys(dependencies), ["resourceAccessor", "getWindowIndex", "getBoxId", "getDefaultViewId", "uploadFile", "downloadFile", "executeShell"]);
    assert.equal(await dependencies.getWindowIndex({} as never), 3);
    assert.deepEqual(box.ready.slice(0, 2), [["ensureReady", "box-1"], ["windowIndex", "box-1"]], "readiness comes before the lookup");
    await dependencies.uploadFile({} as never, "box-1" as never, "/tmp/file" as never, new Uint8Array([9]) as never);
    assert.equal(box.uploaded.length, 1);
    assert.deepEqual(box.uploaded[0], ["box-1", "/tmp/file", new Uint8Array([9])], "the upload carries the box, the path and the bytes");
    assert.deepEqual(await dependencies.downloadFile({} as never, "box-1" as never, "/tmp/file" as never), new Uint8Array([1, 2, 3]));
    assert.deepEqual([dependencies.getBoxId(), dependencies.getDefaultViewId()], ["box-1", "view-1"]);
  });

  it("maps a shell result to the driver's outcome and carries the optional hooks only when set", async () => {
    const full = createHostBrowserDriverDependencies({ resourceAccessor: { get: () => shell }, box, getBoxId: () => "b", getDefaultViewId: () => "v", executeShell: shell, getPersistImage: async () => undefined, autoReview: {} } as never) as never as Record<string, unknown>;
    assert.deepEqual(Object.keys(full).slice(-2), ["getPersistImage", "autoReview"]);
    assert.deepEqual(await (full.executeShell as (context: unknown, input: unknown) => Promise<unknown>)({}, { command: "ls" }), { case: "success", stdout: "o", stderr: "e", exitCode: 2 });
    const failedShell = { async execute() { return { result: { case: "rejected", value: {} } }; } };
    const failed = createHostBrowserDriverDependencies({ resourceAccessor: { get: () => failedShell }, box, getBoxId: () => "b", getDefaultViewId: () => "v", executeShell: failedShell } as never);
    assert.deepEqual(await failed.executeShell({} as never, { command: "ls" } as never), { case: "rejected" });
    const unnamed = { async execute() { return { result: {} }; } };
    const empty = createHostBrowserDriverDependencies({ resourceAccessor: { get: () => unnamed }, box, getBoxId: () => "b", getDefaultViewId: () => "v", executeShell: unnamed } as never);
    assert.deepEqual(await empty.executeShell({} as never, { command: "ls" } as never), { case: "" });
    const throwing = { async execute() { throw new Error("driver shell exploded"); } };
    const broken = createHostBrowserDriverDependencies({ resourceAccessor: { get: () => throwing }, box, getBoxId: () => "b", getDefaultViewId: () => "v", executeShell: throwing } as never);
    await assert.rejects(() => broken.executeShell({} as never, { command: "ls" } as never), { message: "driver shell exploded" });
  });
});
