/**
 * What a shared desktop assigns, restores, persists and releases across the agents using one box.
 */

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Context } from "../../source/packages/context/context.ts";
import { BoxFileUnreadableError } from "../../source/host/boxes/box-transfer.ts";
import {
  ASSIGNMENTS_LOAD_RETRY_INTERVAL_MS,
  ASSIGNMENTS_LOAD_TIMEOUT_MS,
  DEFAULT_SHARED_BOX_ID,
  SHARED_DESKTOP_ASSIGNMENTS_BOX_PATH,
  SharedDesktopBox,
  parseAssignments,
  resolveSharedBoxId,
  type SharedInnerBox,
} from "../../source/host/boxes/shared-desktop-slate-box.ts";
import { SLATE_BOX_FIRST_FORK_WINDOW_INDEX, SLATE_BOX_PRIMARY_WINDOW_INDEX } from "../../source/host/ports/box.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

interface WorldOptions {
  readonly sharedBoxId?: string;
  readonly maxWindows?: number;
  readonly persist?: boolean;
  readonly downloaded?: readonly (Uint8Array | Error)[];
  readonly ensureWindow?: (agentId: string, windowIndex: number, ownerToken: string | undefined) => Promise<{ windowIndex: number; computerUse: string; vncUrl: string }>;
  readonly releaseWindow?: (windowIndex: number) => Promise<void>;
  readonly upload?: (path: string, contents: Uint8Array) => Promise<void>;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly reportPersistFailure?: (error: unknown) => void;
}

function world(options: WorldOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), "slate-shared-box-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const uploads: Array<{ path: string; contents: string }> = [];
  const released: number[] = [];
  let downloadIndex = 0;
  const ctx = {} as Context;
  const inner: SharedInnerBox<string> = {
    maxWindows: () => options.maxWindows ?? 3,
    ensureReady: async (_context, agentId) => {
      calls.push({ method: "ensureReady", args: [agentId] });
      return { remoteAccessor: "primary", vncUrl: "vnc-primary", terminalsFolder: "/terminals" };
    },
    ensureWindow: async (_context, agentId, index, request) => {
      calls.push({ method: "ensureWindow", args: [agentId, index, request?.ownerToken] });
      if (options.ensureWindow !== undefined) return options.ensureWindow(agentId, index, request?.ownerToken);
      return { windowIndex: index, computerUse: "fork-" + index, vncUrl: "vnc-" + index };
    },
    releaseWindow: async (_context, _agentId, index) => {
      released.push(index);
      await options.releaseWindow?.(index);
    },
    recreateInBox: async (_context, request) => (calls.push({ method: "recreateInBox", args: [request] }), { started: true }),
    runState: async (_context, agentId) => (calls.push({ method: "runState", args: [agentId] }), "ready"),
    listBoxes: async () => [{ agentId: "shared", running: true }],
    uploadFile: async (_context, agentId, path, contents) => {
      calls.push({ method: "uploadFile", args: [agentId, path] });
      uploads.push({ path, contents: Buffer.from(contents).toString("utf8") });
      await options.upload?.(path, contents);
    },
    downloadFile: async (_context, agentId, path) => {
      calls.push({ method: "downloadFile", args: [agentId, path] });
      const result = options.downloaded?.[Math.min(downloadIndex++, (options.downloaded?.length ?? 1) - 1)] ?? Buffer.alloc(0);
      if (result instanceof Error) throw result;
      return result;
    },
    applyEnvironment: async (_context, update) => { calls.push({ method: "applyEnvironment", args: [update] }); },
    loadMcpServers: async (_context, config) => (calls.push({ method: "loadMcpServers", args: [config] }), []),
    mcpResourceAccessor: async () => (calls.push({ method: "mcpResourceAccessor", args: [] }), "mcp"),
    dispose: async () => { calls.push({ method: "dispose", args: [] }); },
  };
  const box = new SharedDesktopBox(inner, {
    sharedBoxId: options.sharedBoxId ?? "shared-box-9",
    ...(options.persist === undefined ? {} : { persistAssignments: options.persist }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
    ...(options.reportPersistFailure === undefined ? {} : { reportPersistFailure: options.reportPersistFailure }),
    gateComputerUse: (primary) => ({ ...primary, remoteAccessor: "gated" }),
  });
  return { root, box, calls, uploads, released, ctx, inner };
}

function assignmentFile(assignments: Record<string, number>, tokens: Record<string, string> = {}): Uint8Array {
  return Buffer.from(JSON.stringify({ assignments, tokens }), "utf8");
}

describe("the saved assignment format", () => {
  it("keeps only valid indices, gives a fork to the first sorted owner and reads its token", () => {
    const parsed = parseAssignments(assignmentFile({
      "z-agent": SLATE_BOX_FIRST_FORK_WINDOW_INDEX,
      "a-agent": SLATE_BOX_FIRST_FORK_WINDOW_INDEX,
      "primary-one": SLATE_BOX_PRIMARY_WINDOW_INDEX,
      "primary-two": SLATE_BOX_PRIMARY_WINDOW_INDEX,
      "zero": 0,
      "outside": 99,
    }, { "a-agent": "owner-a", "z-agent": "owner-z", "primary-one": "primary-token", "zero": "nope" }), 3);
    assert.deepEqual([...parsed.assignments.entries()], [["a-agent", 2], ["primary-one", 1], ["primary-two", 1]]);
    assert.deepEqual([...parsed.tokens.entries()], [["a-agent", "owner-a"], ["primary-one", "primary-token"]]);
    assert.deepEqual([parseAssignments(Buffer.from("{"), 3).isCorrupt, parseAssignments(Buffer.from("[]"), 3).isCorrupt], [true, false]);
  });

  it("uses a configured id before the environment and otherwise falls back to the shared id", () => {
    assert.deepEqual(
      [resolveSharedBoxId("explicit", { SLATE_SHARED_BOX_ID: " env " }), resolveSharedBoxId(undefined, { SLATE_SHARED_BOX_ID: " env " }), resolveSharedBoxId(undefined, { SLATE_SHARED_BOX_ID: "  " })],
      ["explicit", "env", DEFAULT_SHARED_BOX_ID],
    );
    assert.deepEqual([ASSIGNMENTS_LOAD_TIMEOUT_MS, ASSIGNMENTS_LOAD_RETRY_INTERVAL_MS], [30_000, 1_000]);
  });
});

describe("assigning windows to agents", () => {
  it("allocates distinct fork windows until the box is full and does not assign the primary seat", () => {
    const current = world({ maxWindows: 3 });
    assert.deepEqual(
      [current.box.assignWindow("a"), current.box.assignWindow("b"), current.box.assignWindow("c"), current.box.assignWindow("a")],
      [2, 3, undefined, 2],
    );
    assert.equal(current.box.getAgentWindowIndex("a"), 2);
  });

  it("does not reuse a fork while its old owner is releasing it", async () => {
    let finishRelease!: () => void;
    const releasing = new Promise<void>((resolve) => { finishRelease = resolve; });
    const current = world({ maxWindows: 3, releaseWindow: () => releasing });
    current.box.assignWindow("first");
    const release = current.box.releaseWindow(current.ctx, "first");
    assert.equal(current.box.assignWindow("during-release"), 3);
    finishRelease();
    await release;
    assert.equal(current.box.assignWindow("after-release"), 2);
  });

  it("falls back to primary computer use when there is no fork or fork support", async () => {
    const noCapacity = world({ maxWindows: 1 });
    assert.deepEqual(await noCapacity.box.ensureReady(noCapacity.ctx, "agent"), {
      remoteAccessor: "gated",
      vncUrl: "vnc-primary",
      terminalsFolder: "/terminals",
    });
    assert.deepEqual(noCapacity.calls.map((call) => call.method), ["ensureReady"]);

    const noForks = world();
    delete noForks.inner.ensureWindow;
    assert.equal((await noForks.box.ensureReady(noForks.ctx, "agent")).remoteAccessor, "gated");
    assert.equal(noForks.box.getAgentWindowIndex("agent"), undefined);
  });

  it("hands each agent its owned accessor and a unique persisted token", async () => {
    const current = world({ maxWindows: 3 });
    const first = await current.box.ensureReady(current.ctx, "agent-a");
    const second = await current.box.ensureReady(current.ctx, "agent-b");
    const windows = current.calls.filter((call) => call.method === "ensureWindow");
    assert.deepEqual([first.remoteAccessor, second.remoteAccessor, first.terminalsFolder, second.terminalsFolder], ["fork-2", "fork-3", "/terminals", "/terminals"]);
    assert.deepEqual(windows.map((call) => call.args.slice(1, 2)), [[2], [3]]);
    assert.equal(typeof windows[0]?.args[2], "string");
    assert.notEqual(windows[0]?.args[2], windows[1]?.args[2]);
  });

  it("moves a restored legacy primary assignment to a free fork, and restores it on bring-up failure", async () => {
    const current = world({
      persist: true,
      maxWindows: 3,
      downloaded: [assignmentFile({ "agent-a": 1 }, { "agent-a": "legacy-owner" })],
      ensureWindow: async () => { throw new Error("fork is unavailable"); },
    });
    const result = await current.box.ensureReady(current.ctx, "agent-a");
    assert.equal(result.remoteAccessor, "primary");
    assert.equal(current.box.getAgentWindowIndex("agent-a"), 1);
    assert.deepEqual(current.released, [2]);
    await current.box.flushPersistence();
    const last = JSON.parse(current.uploads.at(-1)?.contents ?? "{}") as { assignments: Record<string, number>; tokens: Record<string, string> };
    assert.deepEqual([last.assignments["agent-a"], last.tokens["agent-a"]], [1, undefined]);
  });

  it("rolls back a new assignment if a fork fails and writes the empty ownership set", async () => {
    const current = world({
      persist: true,
      maxWindows: 3,
      downloaded: [assignmentFile({})],
      ensureWindow: async () => { throw new Error("fork refused"); },
    });
    await assert.rejects(current.box.ensureReady(current.ctx, "agent-a"), /fork refused/);
    await current.box.flushPersistence();
    assert.equal(current.box.getAgentWindowIndex("agent-a"), undefined);
    assert.deepEqual(current.released, [2]);
    const saved = JSON.parse(current.uploads.at(-1)?.contents ?? "{}") as { assignments: Record<string, number> };
    assert.deepEqual(saved.assignments, {});
  });
});

describe("restoring and persisting assignments", () => {
  it("loads once, skips conflicting fork owners and retries an empty checkpoint", async () => {
    const current = world({
      persist: true,
      maxWindows: 4,
      downloaded: [
        Buffer.alloc(0),
        assignmentFile({ "agent-b": 2, "agent-a": 2, legacy: 1 }, { "agent-a": "owner-a", legacy: "primary" }),
      ],
      now: (() => { let time = 0; return () => time; })(),
      sleep: async () => {},
    });
    await Promise.all([current.box.ensureAssignmentsLoaded(current.ctx), current.box.ensureAssignmentsLoaded(current.ctx)]);
    assert.equal(current.calls.filter((call) => call.method === "downloadFile").length, 2);
    assert.deepEqual([current.box.getAgentWindowIndex("agent-a"), current.box.getAgentWindowIndex("agent-b"), current.box.getAgentWindowIndex("legacy")], [2, undefined, 1]);
    assert.equal(current.box.assignWindow("agent-b"), 3);
  });

  it("treats an unreadable assignment file as a disabled restore, but retries other read errors until the deadline", async () => {
    const unreadable = world({ persist: true, downloaded: [new BoxFileUnreadableError("not ready")] });
    await unreadable.box.ensureAssignmentsLoaded(unreadable.ctx);
    assert.equal(unreadable.calls.filter((call) => call.method === "downloadFile").length, 1);

    let time = 0;
    const retry = world({
      persist: true,
      downloaded: [new Error("transient read"), assignmentFile({ legacy: 1 }, { legacy: "token" })],
      now: () => time,
      sleep: async (ms) => { time += ms; },
    });
    await retry.box.ensureAssignmentsLoaded(retry.ctx);
    assert.equal(retry.calls.filter((call) => call.method === "downloadFile").length, 2);
    assert.equal(retry.box.getAgentWindowIndex("legacy"), 1);
  });

  it("serializes assignment snapshots and keeps the most recent ownership map", async () => {
    const current = world({ persist: true, downloaded: [assignmentFile({})] });
    await current.box.ensureAssignmentsLoaded(current.ctx);
    current.box.assignWindow("first");
    current.box.queuePersistAssignments(current.ctx);
    current.box.assignWindow("second");
    current.box.queuePersistAssignments(current.ctx);
    await current.box.flushPersistence();
    assert.equal(current.uploads.length, 2);
    assert.deepEqual(JSON.parse(current.uploads[0]!.contents).assignments, { first: 2 });
    assert.deepEqual(JSON.parse(current.uploads[1]!.contents).assignments, { first: 2, second: 3 });
  });

  it("uses one shared box id for run state and file access, and disposes the underlying box", async () => {
    const current = world({ sharedBoxId: "box" });
    assert.deepEqual([
      await current.box.runState(current.ctx),
      await current.box.uploadFile(current.ctx, "agent-a", "/x", new Uint8Array([1])),
      await current.box.downloadFile(current.ctx, "agent-b", "/y"),
    ], ["ready", undefined, Buffer.alloc(0)]);
    await current.box.applyEnvironment(current.ctx, { name: "value" });
    assert.deepEqual(await current.box.loadMcpServers(current.ctx, "{}"), []);
    assert.equal(await current.box.mcpResourceAccessor(current.ctx), "mcp");
    current.box.assignWindow("agent-a");
    assert.equal((await current.box.listBoxes())[0]?.running, true);
    await current.box.recreateInBox(current.ctx, { preserveData: true });
    await current.box.dispose();
    assert.equal(current.calls.at(-1)?.method, "dispose");
    assert.equal(current.calls.some((call) => call.method === "uploadFile" && call.args[0] === "box"), true);
  });
});
