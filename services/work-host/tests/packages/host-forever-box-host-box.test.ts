import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { BoxEnvironmentSyncUnsupportedError, BoxMcpUnsupportedError } from "../../source/host/ports/box.ts";
import { createContext } from "../../source/packages/context/context.ts";
import {
  BoxCapabilityError,
  HostBox,
  RUN_STATE_PROBE_AGENT_ID,
  type BoxStatus,
  type HostBoxInner,
} from "../../source/host/boxes/forever-box/host-box.ts";

function createInner(overrides: Partial<HostBoxInner> = {}): HostBoxInner {
  return {
    ensureReady: async (_ctx, agentId) => ({ vncUrl: `vnc://${agentId}` }),
    runState: async () => "running",
    listBoxes: async () => [],
    uploadFile: async () => {},
    downloadFile: async () => new Uint8Array(),
    ...overrides,
  };
}

describe("the host's box facade", () => {
  it("stores ready connections and notifies subscribers with the running view", async () => {
    const box = new HostBox(createInner());
    const updates: BoxStatus[] = [];
    const unsubscribe = box.subscribe((status) => updates.push(status));
    const connection = await box.ensureReady(createContext(), "agent-a");

    assert.deepEqual(connection, { vncUrl: "vnc://agent-a" });
    assert.equal(box.vncUrls.get("agent-a"), "vnc://agent-a");
    assert.deepEqual(updates, [{ agentId: "agent-a", state: "running", vncUrl: "vnc://agent-a", windows: [{ windowIndex: 0, vncUrl: "vnc://agent-a" }] }]);
    unsubscribe();
    await box.ensureReady(createContext(), "agent-b");
    assert.equal(updates.length, 1);
  });

  it("lists the primary window first and sorts fork indices", () => {
    const box = new HostBox(createInner());
    box.vncUrls.set("agent-a", "vnc://primary");
    box.forkVncUrls.set("agent-a", new Map([[5, "vnc://five"], [2, "vnc://two"]]));
    box.forkVncUrls.set("agent-b", new Map([[3, "vnc://three"], [1, "vnc://one"]]));

    assert.deepEqual(box.buildWindows("agent-a"), [
      { windowIndex: 0, vncUrl: "vnc://primary" },
      { windowIndex: 2, vncUrl: "vnc://two" },
      { windowIndex: 5, vncUrl: "vnc://five" },
    ]);
    assert.deepEqual(box.buildWindows("agent-b"), [
      { windowIndex: 1, vncUrl: "vnc://one" },
      { windowIndex: 3, vncUrl: "vnc://three" },
    ]);
    assert.equal(box.buildWindows("agent-c"), undefined);
  });

  it("adds a fork window after ensuring the main connection and preserves call arguments", async () => {
    const ctx = createContext();
    const options = { owner: "lease-1" };
    const calls: unknown[][] = [];
    const inner = createInner({
      ensureReady: async (_context, agentId) => ({ vncUrl: `main://${agentId}`, imageUpdateAvailable: true }),
      ensureWindow: async (...args) => {
        calls.push(args);
        return { windowIndex: 4, vncUrl: "fork://four" };
      },
    });
    const box = new HostBox(inner);
    const updates: BoxStatus[] = [];
    box.subscribe((status) => updates.push(status));

    const result = await box.ensureWindow(ctx, "agent-a", 4, options);
    assert.deepEqual(calls, [[ctx, "agent-a", 4, options]]);
    assert.deepEqual(result, { windowIndex: 4, vncUrl: "fork://four" });
    assert.deepEqual(box.buildWindows("agent-a"), [
      { windowIndex: 0, vncUrl: "main://agent-a" },
      { windowIndex: 4, vncUrl: "fork://four" },
    ]);
    assert.deepEqual(updates.at(-1), {
      agentId: "agent-a", state: "running", vncUrl: "main://agent-a",
      windows: [{ windowIndex: 0, vncUrl: "main://agent-a" }, { windowIndex: 4, vncUrl: "fork://four" }],
      imageUpdateAvailable: true,
    });
  });

  it("replaces the main URL when ensureWindow returns index zero", async () => {
    const box = new HostBox(createInner({
      ensureReady: async () => ({ vncUrl: "main://old" }),
      ensureWindow: async () => ({ windowIndex: 0, vncUrl: "main://new" }),
    }));
    await box.ensureWindow(createContext(), "agent-a", 0);
    assert.equal(box.vncUrls.get("agent-a"), "main://new");
    assert.deepEqual(box.buildWindows("agent-a"), [{ windowIndex: 0, vncUrl: "main://new" }]);
  });

  it("refuses multi-window requests if the underlying box has no such capability", async () => {
    const box = new HostBox(createInner());
    await assert.rejects(
      () => box.ensureWindow(createContext(), "agent-a", 1),
      (error: unknown) => error instanceof BoxCapabilityError && error.message === "This box does not support multiple desktop windows.",
    );
  });

  it("suppresses release failures and reports absence after clearing cached windows", async () => {
    const box = new HostBox(createInner({
      ensureReady: async () => ({ vncUrl: "main://one", imageUpdateAvailable: true }),
      releaseWindow: async () => { throw new Error("release failed"); },
    }));
    const updates: BoxStatus[] = [];
    box.subscribe((status) => updates.push(status));
    await box.ensureReady(createContext(), "agent-a");
    box.forkVncUrls.set("agent-a", new Map([[2, "fork://two"]]));

    await box.releaseWindow(createContext(), "agent-a");
    assert.equal(box.vncUrls.has("agent-a"), false);
    assert.equal(box.forkVncUrls.has("agent-a"), false);
    assert.deepEqual(updates.at(-1), { agentId: "agent-a", state: "absent", vncUrl: null });

    const countAfterRelease = updates.length;
    box.recordImageUpdateAvailable(false);
    assert.equal(updates.length, countAfterRelease, "released agents are no longer retained for image status updates");
  });

  it("does not clear a connection established while a release is in flight", async () => {
    let finishRelease!: () => void;
    const releasePending = new Promise<void>((resolve) => { finishRelease = resolve; });
    let readyCount = 0;
    const box = new HostBox(createInner({
      ensureReady: async () => ({ vncUrl: `main://${++readyCount}` }),
      releaseWindow: async () => releasePending,
    }));
    const updates: BoxStatus[] = [];
    box.subscribe((status) => updates.push(status));
    await box.ensureReady(createContext(), "agent-a");
    const release = box.releaseWindow(createContext(), "agent-a");
    await box.ensureReady(createContext(), "agent-a");
    finishRelease();
    await release;

    assert.equal(box.vncUrls.get("agent-a"), "main://2");
    assert.deepEqual(updates.at(-1), {
      agentId: "agent-a", state: "running", vncUrl: "main://2", windows: [{ windowIndex: 0, vncUrl: "main://2" }],
    });
  });

  it("clears stale window URLs for a non-running state but keeps image availability", async () => {
    const box = new HostBox(createInner({
      ensureReady: async () => ({ vncUrl: "main://one", imageUpdateAvailable: true }),
      runState: async () => "hibernated",
    }));
    await box.ensureReady(createContext(), "agent-a");
    box.forkVncUrls.set("agent-a", new Map([[2, "fork://two"]]));

    assert.deepEqual(await box.getStatus(createContext(), "agent-a"), {
      agentId: "agent-a", state: "hibernated", vncUrl: null, imageUpdateAvailable: true,
    });
    assert.equal(box.vncUrls.has("agent-a"), false);
    assert.equal(box.forkVncUrls.has("agent-a"), false);
  });

  it("reports running without a URL as absent instead of inventing a connection", async () => {
    const box = new HostBox(createInner({ runState: async () => "running" }));
    assert.deepEqual(await box.getStatus(createContext(), "agent-a"), {
      agentId: "agent-a", state: "absent", vncUrl: null,
    });
  });

  it("updates reported statuses only when the image-availability value changes", async () => {
    const box = new HostBox(createInner({ ensureReady: async () => ({ vncUrl: "main://one", imageUpdateAvailable: true }) }));
    const updates: BoxStatus[] = [];
    box.subscribe((status) => updates.push(status));
    await box.ensureReady(createContext(), "agent-a");

    box.recordImageUpdateAvailable(undefined);
    box.recordImageUpdateAvailable(false);
    box.recordImageUpdateAvailable(false);
    box.recordImageUpdateAvailable(true);
    box.recordConnection("agent-b", { vncUrl: "main://two" });

    assert.deepEqual(updates.map(({ imageUpdateAvailable }) => imageUpdateAvailable), [true, false, true]);
    assert.equal(box.getImageUpdateAvailable(), true);
  });

  it("forwards host capabilities and provides honest defaults when they are absent", async () => {
    const ctx = createContext();
    const uploaded = { data: new Uint8Array([1, 2]) };
    const calls: unknown[][] = [];
    const inner = createInner({
      runState: async (_context, agentId) => (calls.push(["runState", agentId]), "running"),
      listBoxes: async () => [{ agentId: "agent-a", running: true }],
      uploadFile: async (...args) => { calls.push(["upload", ...args]); },
      downloadFile: async (...args) => (calls.push(["download", ...args]), uploaded.data),
      getAgentWindowIndex: (agentId) => (calls.push(["windowIndex", agentId]), 3),
      getTerminalsFolder: () => "/terminals",
      maxWindows: () => 4,
      isAvailable: () => false,
      isPreparing: (agentId) => agentId === "agent-a",
      describe: () => ({ description: "box" }),
    });
    const box = new HostBox(inner);

    assert.equal(await box.runState(ctx, "agent-a"), "running");
    assert.deepEqual(await box.listBoxes(), [{ agentId: "agent-a", running: true }]);
    assert.equal(await box.isAvailable(), false);
    assert.equal(box.isPreparing("agent-a"), true);
    assert.deepEqual(box.describe(), { description: "box" });
    assert.equal(box.maxWindows(), 4);
    assert.equal(box.getTerminalsFolder(), "/terminals");
    assert.equal(box.getAgentWindowIndex("agent-a"), 3);
    await box.uploadFile(ctx, "agent-a", "file.txt", uploaded.data);
    assert.equal(await box.downloadFile(ctx, "agent-a", "file.txt"), uploaded.data);
    assert.deepEqual(calls[0], ["runState", "agent-a"]);

    const defaults = new HostBox(createInner());
    assert.equal(await defaults.isAvailable(), true);
    assert.equal(defaults.isPreparing("agent-a"), false);
    assert.equal(defaults.maxWindows(), 1);
    assert.equal(defaults.getTerminalsFolder(), undefined);
    assert.equal(defaults.getAgentWindowIndex("agent-a"), undefined);
  });

  it("uses the empty agent id for the run-state probe and delegates recreate options", async () => {
    const ctx = createContext();
    const options = { preserveData: true, force: true };
    const calls: unknown[][] = [];
    const box = new HostBox(createInner({
      runState: async (_context, agentId) => (calls.push(["state", agentId]), "running"),
      recreateInBox: async (_context, input) => (calls.push(["recreate", input]), { started: true }),
    }));

    assert.equal(await box.isBoxRunning(ctx), true);
    assert.equal(RUN_STATE_PROBE_AGENT_ID, "");
    assert.equal(calls[0]?.[1], "");
    assert.deepEqual(await box.recreateInBox(ctx, options), { started: true });
    assert.equal(calls[1]?.[1], options);
  });

  it("refuses unsupported environment, MCP, and recreation operations by error identity", async () => {
    const box = new HostBox(createInner());
    await assert.rejects(() => box.applyEnvironment(createContext(), {}), BoxEnvironmentSyncUnsupportedError);
    await assert.rejects(() => box.loadMcpServers(createContext(), "{}"), BoxMcpUnsupportedError);
    await assert.rejects(() => box.mcpResourceAccessor(createContext()), BoxMcpUnsupportedError);
    await assert.rejects(
      () => box.recreateInBox(createContext(), { preserveData: false }),
      (error: unknown) => error instanceof BoxCapabilityError && error.message === "This computer can't be recreated from inside the box.",
    );
  });

  it("forwards optional environment and MCP capabilities when the box provides them", async () => {
    const ctx = createContext();
    const update = { name: "env" };
    const mcpConfig = "{\"mcpServers\":{}}";
    const calls: unknown[][] = [];
    const accessor = { kind: "resources" };
    const box = new HostBox(createInner({
      applyEnvironment: async (...args) => { calls.push(["environment", ...args]); },
      loadMcpServers: async (...args) => (calls.push(["servers", ...args]), ["loaded"]),
      mcpResourceAccessor: async (...args) => (calls.push(["accessor", ...args]), accessor),
    }));

    await box.applyEnvironment(ctx, update);
    assert.deepEqual(await box.loadMcpServers(ctx, mcpConfig), ["loaded"]);
    assert.equal(await box.mcpResourceAccessor(ctx), accessor);
    assert.deepEqual(calls, [
      ["environment", ctx, update],
      ["servers", ctx, mcpConfig],
      ["accessor", ctx],
    ]);
  });
});
