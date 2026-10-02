/**
 * The transcript manager: the no-ops it starts with, the pieces it owns and wires together, the attachment helpers it
 * builds for a turn, everything it forwards to whichever piece owns it, and what it lets go of when it is disposed.
 */

import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it } from "node:test";

import {
  createTranscriptTaskBoundary,
  EMPTY_FOREVER_BOX,
  NO_CONTENT_SEARCH,
  NO_MEMORY,
  NO_TRAY_ERRORS,
  NOOP_TRANSCRIPT_ATTACHMENTS,
  TranscriptManager,
  UNWIRED_TURN_EXECUTION,
  unavailableMemoryStore,
} from "../../source/host/transcript/transcript-manager.ts";
import { RUNNER_UNATTACHED_MESSAGE } from "../../source/host/transcript/transcript-hub.ts";
import { SlateChannelDeliveryUnregisteredError } from "../../source/host/transcript/channel-delivery-unregistered-error.ts";
import { getAgentAssetsDir, getAgentAttachmentsDir } from "../../source/host/attachments/attachment-paths.ts";

type Call = { name: string; args: unknown[] };

/** A session with the little the manager asks of it, and a record of what was asked. */
function fakeSession(id: string, calls: Call[], dbPath = join("/agents", id, "store.db")) {
  return {
    id,
    dbPath,
    agentStore: { dispose: async () => calls.push({ name: "agentStore.dispose", args: [id] }) },
    db: {
      close: (options: unknown) => calls.push({ name: "db.close", args: [id, options] }),
      clearMemoryPromptSnapshot: () => calls.push({ name: "db.clearMemoryPromptSnapshot", args: [id] }),
    },
  };
}

/** The store the manager is built over, with an answer for everything it asks. */
function fakeStore() {
  const calls: Call[] = [];
  const record = (name: string, ...args: unknown[]) => {
    calls.push({ name, args });
  };
  let beingDeleted: ((id: string) => boolean) | undefined;
  return {
    calls,
    named: (name: string) => calls.filter((call) => call.name === name),
    beingDeleted: () => beingDeleted,
    store: {
      setBeingDeletedPredicate: (predicate: (id: string) => boolean) => {
        beingDeleted = predicate;
        record("setBeingDeletedPredicate");
      },
      cleanupLegacyGroupMemberDirs: () => record("cleanupLegacyGroupMemberDirs"),
      setMemory: (memory: unknown) => record("setMemory", memory),
      clearAgentMemoryPromptSnapshot: async (id: string) => record("clearAgentMemoryPromptSnapshot", id),
      listAgentChannels: async (id: string) => {
        record("listAgentChannels", id);
        return ["channel"];
      },
      listAgentIds: () => {
        record("listAgentIds");
        return ["agent-1"];
      },
      listChannelConfigs: (id: string) => {
        record("listChannelConfigs", id);
        return ["config"];
      },
      getAgentAvatarPng: (id: string) => {
        record("getAgentAvatarPng", id);
        return "png";
      },
      getAgentProfileText: (id: string) => {
        record("getAgentProfileText", id);
        return "profile";
      },
      storeConnectorCredential: (agentId: string, platform: string, kind: string, value: string) => {
        record("storeConnectorCredential", agentId, platform, kind, value);
        return true;
      },
      disconnectChannel: (agentId: string, platform: string) => {
        record("disconnectChannel", agentId, platform);
        return true;
      },
      closeWorkerPool: async () => record("closeWorkerPool"),
    },
  };
}

function managerWorld(acceptanceLedger?: unknown) {
  const fake = fakeStore();
  const manager = new TranscriptManager(fake.store as never, {} as never, {} as never, acceptanceLedger as never);
  return { manager, ...fake };
}

describe("the no-ops a manager starts with", () => {
  it("cannot run a turn until the host wires one in, and says so", async () => {
    assert.deepEqual([UNWIRED_TURN_EXECUTION.canExecute, UNWIRED_TURN_EXECUTION.canExecuteGroupMember], [false, false]);
    assert.equal(await UNWIRED_TURN_EXECUTION.isRunReady(), true);
    assert.throws(() => UNWIRED_TURN_EXECUTION.createRunner(), { message: RUNNER_UNATTACHED_MESSAGE });
    assert.throws(() => UNWIRED_TURN_EXECUTION.createGroupMemberRunner(), { message: RUNNER_UNATTACHED_MESSAGE });
    const world = managerWorld();
    assert.equal(world.manager.execution, UNWIRED_TURN_EXECUTION);
    // And nothing can be delivered to a channel until a delivery is wired in either.
    await assert.rejects(() => world.manager.channelDelivery("agent-1"), SlateChannelDeliveryUnregisteredError);
  });

  it("keeps files where they are, remembers nothing and searches nowhere", async () => {
    assert.deepEqual(await NOOP_TRANSCRIPT_ATTACHMENTS.ingest("/agents/a", "/tmp/one.png"), { absolutePath: "/tmp/one.png" });
    assert.deepEqual(await NOOP_TRANSCRIPT_ATTACHMENTS.ingestBytes("/agents/a", "two.bin"), { absolutePath: join(getAgentAttachmentsDir("/agents/a"), "two.bin") });
    const persisted = await NOOP_TRANSCRIPT_ATTACHMENTS.persistImageBytes("/agents/a/assets", new Uint8Array([1, 2, 3]));
    assert.deepEqual(
      [persisted.absolutePath, persisted.fileUrl, persisted.bytes, persisted.width, persisted.height],
      [join("/agents/a/assets", "unwired-image"), pathToFileURL(join("/agents/a/assets", "unwired-image")).href, 3, null, null],
    );
    assert.equal(await NOOP_TRANSCRIPT_ATTACHMENTS.readImageDimensions("/tmp/one.png"), null);
    assert.deepEqual(await EMPTY_FOREVER_BOX.getStatus({ id: "agent-1" }), { agentId: "agent-1", state: "absent", vncUrl: null });
    assert.equal(await EMPTY_FOREVER_BOX.captureScreenshot(), null);
    assert.deepEqual([NO_TRAY_ERRORS.pushError({}), NO_TRAY_ERRORS.clearForAgent("agent-1")], [undefined, undefined]);

    const store = unavailableMemoryStore();
    assert.deepEqual(store.recall(), { profile: [], recent: [] });
    assert.deepEqual(store.listMemories(), []);
    assert.equal(store.addMemory(), null);
    assert.equal(store.removeMemoryByContent(), false);
    assert.equal(store.getLocation(), null);
    assert.equal(store.removeMemory(), false);
    assert.deepEqual([(store.setOnChange as (handler: unknown) => void)(() => {}), store.clearMemories()], [undefined, undefined]);
    const memory = NO_MEMORY as unknown as {
      agentHasContent(id: string, kind: string): boolean;
      list(): Promise<unknown[]>;
      remove(id: string): Promise<unknown[]>;
      clear(id: string): Promise<unknown[]>;
      setActiveAgent(id: string | null): void;
    };
    assert.equal(memory.agentHasContent("agent-1", "text"), false);
    assert.deepEqual([await memory.list(), await memory.remove("agent-1"), await memory.clear("agent-1")], [[], [], []]);
    assert.equal(memory.setActiveAgent("agent-1"), undefined);

    const search = NO_CONTENT_SEARCH as unknown as {
      isSearchReady: boolean;
      maxMatchesPerAgent: number;
      maxResults: number;
      searchMessages(query: unknown): unknown;
      searchMedia(query: unknown): unknown;
      findTranscriptMatches(query: unknown): unknown[];
    };
    assert.deepEqual([search.isSearchReady, search.maxMatchesPerAgent, search.maxResults], [false, 5, 50]);
    assert.deepEqual([search.searchMessages({}), search.searchMedia({}), search.findTranscriptMatches({})], [null, null, []]);
    await createTranscriptTaskBoundary().settled();
  });
});

describe("the pieces a manager owns", () => {
  it("wires the store's questions to what it holds, and each piece back to itself", () => {
    const world = managerWorld();
    assert.deepEqual([world.named("setBeingDeletedPredicate").length, world.named("cleanupLegacyGroupMemberDirs").length], [1, 1]);
    const beingDeleted = world.beingDeleted();
    assert.notEqual(beingDeleted, undefined);
    world.manager.sessions.deletedAgentIds.add("forgotten");
    assert.deepEqual([beingDeleted?.("forgotten"), beingDeleted?.("live")], [true, false]);

    for (const piece of [
      world.manager.sendPipeline,
      world.manager.turnRuntime,
      world.manager.runnerRegistry,
      world.manager.sessions,
      world.manager.runLifecycle,
      world.manager.roster,
      world.manager.agentLifecycle,
      world.manager.groupChat,
      world.manager.sharedRooms,
      world.manager.backgroundWakes,
      world.manager.pendingWakes,
      world.manager.ackObligations,
      world.manager.upgradeResume,
      world.manager.boxHandoff,
      world.manager.automationRuntime,
      world.manager.workflowCommands,
      world.manager.widgetResponses,
    ])
      assert.equal((piece as { tm: unknown }).tm, world.manager);
    assert.notEqual(world.manager.clientSideToolV2, undefined);
    // The manager starts honest about what it does not have.
    assert.equal(world.manager.memory, NO_MEMORY);
    assert.equal(world.manager.contentSearch, NO_CONTENT_SEARCH);
    assert.equal(world.manager.attachments, NOOP_TRANSCRIPT_ATTACHMENTS);
    assert.equal(world.manager.foreverBox, EMPTY_FOREVER_BOX);
    assert.equal(world.manager.trayErrors, NO_TRAY_ERRORS);
    assert.deepEqual([world.manager.disposed, world.manager.shouldEmitAutomations(), world.manager.xuserDelegate], [false, true, null]);
  });

  it("puts whatever the host hands it in place, memory included", async () => {
    const world = managerWorld();
    const anyView = world.manager as any;
    const memory = { list: () => [] };
    world.manager.setMemory(memory);
    assert.equal(world.manager.memory, memory);
    assert.deepEqual(world.named("setMemory")[0]?.args, [memory]);
    const replacements: Array<[string, unknown]> = [
      ["setTelemetry", { spans: true }],
      ["setProductAnalytics", { events: true }],
      ["setTrayErrors", { pushError: () => {} }],
      ["setAttachments", { ingest: async () => ({ absolutePath: "/x" }) }],
      ["setContentSearch", { isSearchReady: true }],
      ["setForeverBox", { getStatus: async () => null }],
      ["setChannelDelivery", async () => []],
      ["setChannelActivity", () => true],
      ["setChannelConfigChanged", () => true],
      ["setAutomationConfigChanged", () => true],
      ["setShouldEmitAutomations", () => false],
      ["setXuserDelegate", { isEnabled: () => true }],
      ["setTurnExecution", { canExecute: true }],
    ];
    for (const [setter, value] of replacements) anyView[setter](value);
    assert.deepEqual(
      [anyView.telemetry, anyView.productAnalytics, anyView.trayErrors, anyView.attachments, anyView.contentSearch, anyView.foreverBox, anyView.xuserDelegate, anyView.execution],
      [replacements[0]![1], replacements[1]![1], replacements[2]![1], replacements[3]![1], replacements[4]![1], replacements[5]![1], replacements[11]![1], replacements[12]![1]],
    );
    assert.equal(world.manager.shouldEmitAutomations(), false);
    let flushed = 0;
    world.manager.setTraceFlusher(() => {
      flushed += 1;
    });
    world.manager.traceFlusher();
    assert.equal(flushed, 1);
    assert.deepEqual([await anyView.channelActivity(), anyView.channelConfigChanged(), anyView.automationConfigChanged()], [true, true, true]);
  });

  it("remembers what the store remembers, and forgets it with the snapshot", async () => {
    const world = managerWorld();
    const memoryCalls: Array<[string, unknown]> = [];
    world.manager.setMemory({
      list: async (args: unknown) => {
        memoryCalls.push(["list", args]);
        return ["memory"];
      },
      remove: async (args: unknown) => {
        memoryCalls.push(["remove", args]);
        return "removed";
      },
      clear: async (args: unknown) => {
        memoryCalls.push(["clear", args]);
        return "cleared";
      },
      setActiveAgent: (id: unknown) => memoryCalls.push(["active", id]),
    } as never);
    assert.deepEqual(await world.manager.getAgentMemories("agent-1"), ["memory"]);
    assert.deepEqual(await world.manager.deleteAgentMemory("agent-1", "m1"), "removed");
    assert.deepEqual(await world.manager.clearAgentMemories("agent-1"), "cleared");
    assert.deepEqual(memoryCalls, [
      ["list", { agentId: "agent-1" }],
      ["remove", { agentId: "agent-1", memoryId: "m1" }],
      ["clear", { agentId: "agent-1" }],
    ]);
    // Both the removal and the clearing forget what the prompt had built out of them.
    assert.deepEqual(world.named("clearAgentMemoryPromptSnapshot").map((call) => call.args[0]), ["agent-1", "agent-1"]);
    // The conversation on screen forgets it itself; any other conversation is forgotten for by the store.
    const session = fakeSession("agent-1", world.calls);
    (world.manager.sessions as { activeSession: unknown }).activeSession = session;
    await world.manager.clearMemoryPromptSnapshot("agent-1");
    await world.manager.clearMemoryPromptSnapshot("agent-2");
    assert.equal(world.named("db.clearMemoryPromptSnapshot").length, 1);
    assert.deepEqual(world.named("clearAgentMemoryPromptSnapshot").map((call) => call.args[0]), ["agent-1", "agent-1", "agent-2"]);

    // What the store alone can answer, it answers.
    assert.deepEqual(await world.manager.getAgentChannels("agent-1"), ["channel"]);
    assert.deepEqual(world.manager.listAgentIds(), ["agent-1"]);
    assert.deepEqual(world.manager.listChannelConfigs("agent-1"), ["config"]);
    assert.equal(world.manager.getAgentAvatarPng("agent-1"), "png");
    assert.equal(world.manager.getAgentProfileText("agent-1"), "profile");
    assert.deepEqual([await world.manager.connectChannel("agent-1", "slate", "  tok  "), await world.manager.connectChannel("agent-1", "slate", "   ")], [true, false]);
    assert.deepEqual(world.named("storeConnectorCredential")[0]?.args, ["agent-1", "slate", "token", "tok"]);
    assert.equal(world.named("storeConnectorCredential").length, 1);
    assert.equal(await world.manager.disconnectChannel("agent-1", "slate"), true);
    assert.deepEqual(world.named("disconnectChannel")[0]?.args, ["agent-1", "slate"]);
  });

  it("builds the attachment helpers a turn needs, and swallows only their failures", async () => {
    const world = managerWorld();
    const session = fakeSession("agent-1", world.calls, join("/agents", "agent-1", "store.db"));
    const seen: Array<[string, unknown[]]> = [];
    world.manager.setAttachments({
      ingest: async (...args: unknown[]) => {
        seen.push(["ingest", args]);
        return { absolutePath: "/ingested/one.png" };
      },
      ingestBytes: async (...args: unknown[]) => {
        seen.push(["ingestBytes", args]);
        return { absolutePath: join("/agents/agent-1/attachments", "two.bin") };
      },
      persistImageBytes: async (...args: unknown[]) => {
        seen.push(["persistImageBytes", args]);
        return { absolutePath: "/agents/agent-1/assets/img.png", fileUrl: "file:///img.png", bytes: 2, width: 4, height: 6 };
      },
    } as never);
    const ingest = world.manager.createAttachmentIngestor(session as never);
    assert.equal(await ingest("/tmp/one.png"), "/ingested/one.png");
    assert.deepEqual(seen[0], ["ingest", [join("/agents", "agent-1"), "/tmp/one.png"]]);
    const persistImage = world.manager.createAssetImagePersister(session as never);
    assert.deepEqual(await persistImage(new Uint8Array([1, 2]), "image/png"), { absolutePath: "/agents/agent-1/assets/img.png", fileUrl: "file:///img.png", bytes: 2, width: 4, height: 6 });
    assert.deepEqual(seen[1], ["persistImageBytes", [getAgentAssetsDir(join("/agents", "agent-1")), new Uint8Array([1, 2]), "image/png"]]);
    const persistMedia = world.manager.createMediaBytesPersister(session as never);
    assert.equal(await persistMedia("two.bin", new Uint8Array([3])), pathToFileURL(join("/agents/agent-1/attachments", "two.bin")).href);
    assert.deepEqual(seen[2], ["ingestBytes", [join("/agents", "agent-1"), "two.bin", new Uint8Array([3])]]);
    // A helper that failed is a null, not a broken turn.
    world.manager.setAttachments({
      ingest: async () => ({ absolutePath: "/x" }),
      ingestBytes: async () => {
        throw new Error("no room");
      },
      persistImageBytes: async () => {
        throw new Error("no room");
      },
    } as never);
    assert.equal(await world.manager.createAssetImagePersister(session as never)(new Uint8Array(), "image/png"), null);
    assert.equal(await world.manager.createMediaBytesPersister(session as never)("two.bin", new Uint8Array()), null);
  });

  it("keeps the observers it is handed, and tells the run lifecycle about a run", () => {
    const world = managerWorld();
    const seen: unknown[] = [];
    const anyView = world.manager as any;
    const observers: Array<[string, string]> = [
      ["setAgentForgottenObserver", "onAgentForgotten"],
      ["setListenerConnectObserver", "onListenerConnectCard"],
      ["setConnectorConnectCardObserver", "onConnectorConnectCard"],
      ["setAgentRunLifecycleObserver", "agentRunLifecycleObserver"],
    ];
    for (const [setter, field] of observers) {
      const observer = (value: unknown) => seen.push([field, value]);
      anyView[setter](observer);
      assert.equal(anyView[field], observer);
    }
    world.manager.emitAgentRunLifecycle({ kind: "started" });
    assert.deepEqual(seen, [["agentRunLifecycleObserver", { kind: "started" }]]);
    const bare = managerWorld();
    bare.manager.emitAgentRunLifecycle({ kind: "started" });
  });

  it("knows whether subagents are still running by asking the roster", () => {
    const world = managerWorld();
    const anyView = world.manager as any;
    assert.equal(world.manager.hasAgentsWithRunningSubagents(), false);
    anyView.roster = { liveSubagentParentIds: () => new Set(["parent-1"]) };
    assert.equal(world.manager.hasAgentsWithRunningSubagents(), true);
    anyView.roster = { liveSubagentParentIds: () => new Set() };
    assert.equal(world.manager.hasAgentsWithRunningSubagents(), false);
  });

  it("stops watching what was on screen", () => {
    const world = managerWorld();
    const anyView = world.manager as any;
    const seen: unknown[] = [];
    world.manager.setMemory({ setActiveAgent: (id: unknown) => seen.push(["active", id]) } as never);
    const watchers: unknown[] = [];
    anyView.automationRuntime = { watchedAutomations: { setOnChange: (handler: unknown) => watchers.push(["automations", handler]) } };
    anyView.workflowCommands = { watchedWorkflows: { setOnChange: (handler: unknown) => watchers.push(["workflows", handler]) } };
    anyView.roster = { stopWatchingProfile: () => seen.push(["profile"]) };
    world.manager.unwatchActiveSession();
    world.manager.unwatchActiveSession();
    assert.deepEqual(seen, [["active", null], ["profile"], ["active", null], ["profile"]]);
    assert.deepEqual(watchers, [["automations", undefined], ["workflows", undefined]]);
    assert.deepEqual([anyView.automationRuntime.watchedAutomations, anyView.workflowCommands.watchedWorkflows], [undefined, undefined]);
  });
});

describe("what the manager forwards", () => {
  const domains = ["roster", "agentLifecycle", "groupChat", "sharedRooms", "backgroundWakes", "pendingWakes", "ackObligations", "upgradeResume", "boxHandoff", "automationRuntime", "workflowCommands", "widgetResponses", "sessions", "runLifecycle", "runnerRegistry", "sendPipeline", "turnRuntime"] as const;

  /** A manager whose every piece is a spy that answers with its own name. */
  function spiedWorld() {
    const world = managerWorld();
    const received: Array<{ name: string; args: unknown[]; receiver: unknown }> = [];
    const spies: Record<string, unknown> = {};
    for (const domain of domains) {
      const holder: Record<string, unknown> = {};
      const proxy = new Proxy(holder, {
        get(_target, property) {
          const method = String(property);
          if (method === "then") return undefined;
          return function (this: unknown, ...args: unknown[]) {
            received.push({ name: `${domain}.${method}`, args, receiver: this });
            return `${domain}.${method}`;
          };
        },
      });
      spies[domain] = proxy;
      (world.manager as any)[domain] = proxy;
    }
    return { ...world, received, spies };
  }

  it("sends every call to the piece that owns it, with the same arguments and the piece as receiver", () => {
    const world = spiedWorld();
    const forwards: Array<[string, string, unknown[]]> = [
      ["listAgents", "roster", []],
      ["subscribeSubagents", "roster", ["parent-1"]],
      ["createAgent", "agentLifecycle", [{ name: "a" }, "user"]],
      ["setAgentAvatarBytes", "agentLifecycle", ["agent-1", new Uint8Array()]],
      ["createGroup", "groupChat", [{ name: "g", memberIds: ["a"] }]],
      ["postToGroup", "sharedRooms", ["group-1", "hello"]],
      ["wakeForInbound", "backgroundWakes", ["agent-1", ["envelope"]]],
      ["rearmPendingWakes", "pendingWakes", []],
      ["redriveUnfulfilledAckObligations", "ackObligations", ["agent-1"]],
      ["quiesceForUpgrade", "upgradeResume", ["agent-1", "turn"]],
      ["withBoxHandoff", "boxHandoff", ["agent-1", "handoff"]],
      ["getAgentAutomations", "automationRuntime", ["agent-1"]],
      ["importAgentWorkflowMarkdown", "workflowCommands", ["agent-1", "# flow"]],
      ["respondToWidget", "widgetResponses", ["card-1", { answer: true }]],
      ["appendEntry", "sessions", ["agent-1", { id: "t0u" }]],
      ["getRunQueueDiagnostics", "runLifecycle", []],
      ["attachRunner", "runnerRegistry", ["agent-1", { runner: true }]],
      ["sendPrompt", "sendPipeline", ["agent-1", "hi"]],
      ["handleAgentUpdate", "turnRuntime", ["agent-1", { type: "text-delta" }]],
    ];
    for (const [method, domain, args] of forwards) {
      const call = (world.manager as unknown as Record<string, (...args: unknown[]) => unknown>)[method];
      assert.equal(call?.call(world.manager, ...args), `${domain}.${method}`);
      const last = world.received.at(-1);
      assert.deepEqual([last?.name, last?.args, last?.receiver === world.spies[domain]], [`${domain}.${method}`, args, true]);
    }
    // Every name in the forwarding table is one method, installed on the prototype rather than on each instance.
    assert.equal(Object.prototype.hasOwnProperty.call(world.manager, "listAgents"), false);
    assert.equal(typeof (TranscriptManager.prototype as unknown as Record<string, unknown>).listAgents, "function");
  });

  it("answers nothing at all when the piece has nothing to answer with", () => {
    const world = spiedWorld();
    (world.manager as any).widgetResponses = {};
    assert.equal((world.manager as any).dismissWidget("card-1"), undefined);
    (world.manager as any).roster = { listAgents: "not a function" };
    assert.equal((world.manager as any).listAgents(), undefined);
    assert.deepEqual(world.received, []);
  });
});

describe("letting go of everything a manager holds", () => {
  it("closes and forgets every session it has, including half-open ones", async () => {
    const world = managerWorld();
    const anyView = world.manager as any;
    const live = fakeSession("live", world.calls);
    const active = fakeSession("active", world.calls);
    const pending = fakeSession("pending", world.calls);
    anyView.sessions.liveSessions.set("live", live);
    anyView.sessions.activeSession = active;
    anyView.sessions.pendingSessionOpens.set("pending", Promise.resolve(pending));
    let tailSettled = false;
    anyView.sessions.windowedActivationTail = new Promise<void>((resolve) => {
      setTimeout(() => {
        tailSettled = true;
        resolve();
      }, 5);
    });
    await world.manager.dispose();
    assert.equal(world.manager.disposed, true);
    assert.equal(tailSettled, true);
    assert.deepEqual(anyView.sessions.liveSessions.size, 0);
    assert.deepEqual(anyView.sessions.pendingSessionOpens.size, 0);
    assert.deepEqual(
      world.calls.filter((call) => call.name === "agentStore.dispose").map((call) => call.args[0]).sort(),
      ["active", "live", "pending"],
    );
    assert.deepEqual(world.calls.filter((call) => call.name === "db.close").length, 3);
    assert.equal(world.calls.some((call) => call.name === "db.close" && JSON.stringify(call.args[1]) === JSON.stringify({ checkpoint: true })), true);
    assert.equal(world.named("closeWorkerPool").length, 1);
  });

  it("stops every timer, listener and watch it started", async () => {
    const world_stopped: string[] = [];
    const world = managerWorld({ dispose: () => world_stopped.push("ledger") });
    const anyView = world.manager as any;
    anyView.runLifecycle = { runScheduler: { dispose: () => world_stopped.push("scheduler") } };
    anyView.roster = {
      stopOutlineStreamCoalescing: () => world_stopped.push("outline"),
      stopWatchingProfile: () => world_stopped.push("profile"),
    };
    anyView.boxHandoff.foreverBoxListeners.add(() => {});
    anyView.boxHandoff.boxHandoffs.set("agent-1", { id: "handoff" });
    anyView.ackObligations.ackRedriveTimers.set("agent-1", { dispose: () => world_stopped.push("ack-timer") });
    anyView.ackObligations.ackRunTokens.set("agent-1", new Set(["token"]));
    const resolved: unknown[] = [];
    let timerFired = false;
    anyView.automationRuntime.pendingEventFireBatches.set("batch-1", {
      timer: setTimeout(() => {
        timerFired = true;
      }, 5),
      items: [{ resolve: (value: unknown) => resolved.push(value) }],
    });
    anyView.runnerRegistry.runners.set("agent-1", { cancelBackgroundShellRewatches: () => world_stopped.push("runner-shell") });
    anyView.runnerRegistry.activeGroupMemberRunners.set("member-1", { cancelBackgroundShellRewatches: () => world_stopped.push("group-shell") });
    anyView.automationRuntime.watchedAutomations = { setOnChange: () => world_stopped.push("automations-unwatched") };
    anyView.workflowCommands.watchedWorkflows = { setOnChange: () => world_stopped.push("workflows-unwatched") };
    anyView.memory = { setActiveAgent: () => world_stopped.push("memory-unwatched") };

    await world.manager.dispose();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(world_stopped.sort(), [
      "ack-timer",
      "automations-unwatched",
      "group-shell",
      "ledger",
      "memory-unwatched",
      "outline",
      "profile",
      "runner-shell",
      "scheduler",
      "workflows-unwatched",
    ]);
    assert.deepEqual([anyView.ackObligations.ackRedriveTimers.size, anyView.ackObligations.ackRunTokens.size], [0, 0]);
    assert.deepEqual([anyView.boxHandoff.foreverBoxListeners.size, anyView.boxHandoff.boxHandoffs.size], [0, 0]);
    assert.deepEqual([anyView.runnerRegistry.runners.size, anyView.runnerRegistry.activeGroupMemberRunners.size], [0, 0]);
    assert.equal(anyView.automationRuntime.pendingEventFireBatches.size, 0);
    assert.deepEqual(resolved, [undefined]);
    assert.equal(timerFired, false);
    assert.deepEqual([anyView.automationRuntime.watchedAutomations, anyView.workflowCommands.watchedWorkflows], [undefined, undefined]);
  });
});
