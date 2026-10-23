/**
 * A group chat as the conversation machinery sees it: which directories are groups, who is in one, how a room turn
 * reaches its members, how each member's turn is run and streamed, and what is written into the room.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { createGroupMemberStream, GroupChatGlue, SlateGroupCreateError } from "../../source/host/transcript/group-chat-glue.ts";
import { AgentGoneError } from "../../source/host/transcript/session-runtime.ts";
import { getTranscript, setTranscript } from "../../source/host/transcript/transcript-store.ts";
import { GROUP_CONFIG_VERSION, SHARED_ROOM_HISTORY_LIMIT, SlateGroupNestingError, buildGroupRedriveNote } from "../../source/host/groups/group-chat.ts";
import { GROUP_MAX_MEMBERS, getSlateGroupPath, readSlateGroupConfig, writeSlateGroupConfig } from "../../source/host/groups/group-store.ts";
import { buildSharedRoomGuardrailPrompt } from "../../source/host/groups/xuser.ts";
import { getSlateProfilePath, writeSlateProfileFile } from "../../source/host/agents/agent-profile.ts";
import { writeSlateRemoteRoomConfig } from "../../source/host/groups/remote-room-store.ts";
import { formatRemoteAgentId } from "../../source/shared/agents/sharing.ts";
import { SLATE_DEFAULT_AGENT_NAME } from "../../source/shared/agents/agents.ts";

type Call = { name: string; args: unknown[] };

/** A directory of its own for every agent a test needs, with whatever makes it a group or a room. */
function agentsDir() {
  const root = mkdtempSync(join(tmpdir(), "slate-group-glue-"));
  return {
    root,
    plain(id: string, profile: { name?: string; description?: string } = {}) {
      const dir = join(root, id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "store.db"), "");
      if (profile.name !== undefined || profile.description !== undefined)
        writeSlateProfileFile(getSlateProfilePath(dir), { name: profile.name ?? "", description: profile.description ?? "", title: "", avatarShape: "", avatarColor: "" });
      return dir;
    },
    group(id: string, memberIds: string[] = ["member-1"]) {
      const dir = join(root, id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "store.db"), "");
      writeSlateGroupConfig(dir, { version: GROUP_CONFIG_VERSION, memberIds });
      return dir;
    },
    room(id: string) {
      const dir = join(root, id);
      mkdirSync(dir, { recursive: true });
      writeSlateRemoteRoomConfig(dir, { version: 1, roomId: "room-1", hostAuthId: "host-1" } as never);
      return dir;
    },
  };
}

/** A session over a directory, with its own entries and the little the glue asks of it. */
function fakeSession(id: string, directory: string, entries: Array<Record<string, unknown>> = []) {
  const calls: Call[] = [];
  const record = (name: string, ...args: unknown[]) => {
    calls.push({ name, args });
  };
  return {
    id,
    dbPath: join(directory, "store.db"),
    db: {
      getTranscriptEntries: () => entries,
      appendTranscriptEntry: (entry: Record<string, unknown>) => {
        entries.push(entry);
        return true;
      },
    },
    calls,
    named: (name: string) => calls.filter((call) => call.name === name),
  };
}

/** The glue over a manager whose directories, roster and run surface are all written down. */
function world(options: { directories?: Record<string, string>; agents?: Array<Record<string, unknown>>; entries?: Array<Record<string, unknown>> } = {}) {
  const calls: Call[] = [];
  const record = (name: string, ...args: unknown[]) => {
    calls.push({ name, args });
  };
  const directories = options.directories ?? {};
  const storeEntries = structuredClone(options.entries ?? []) as never[];
  setTranscript(storeEntries);
  const root = mkdtempSync(join(tmpdir(), "slate-group-glue-world-"));
  const agents = options.agents ?? [];
  const liveSessions = new Map<string, unknown>();
  const tm = {
    execution: {
      canExecuteGroupMember: true,
      createGroupMemberRunner: (session: unknown, hooks: unknown, overrides: unknown) => {
        record("createGroupMemberRunner", overrides);
        return { hooks, overrides, run: async () => ({ sentMessageCount: 0, reacted: false, aborted: false }) };
      },
    },
    sessions: {
      activeSession: undefined as unknown,
      liveSessions,
      isAgentGone: (id: string) => false,
      openSessionOnce: async (id: string) => {
        record("openSessionOnce", id);
        return fakeSession(id, directories[id] ?? root);
      },
      markActiveSessionArrival: (session: unknown) => record("markActiveSessionArrival"),
    },
    sessionStore: {
      listAgents: async () => agents,
      getAgentDir: (id: string) => directories[id] ?? join(root, id),
      markSessionActivity: (session: unknown) => record("markSessionActivity"),
    },
    roster: {
      reserveSnapshotStamp: () => {
        record("reserveSnapshotStamp");
        return { snapshotEpoch: "epoch", snapshotSeq: 1 };
      },
      finalizeSummaryForRpc: (summary: unknown, stamp: unknown) => ({ ...(summary as object), ...(stamp as object) }),
      emitAgents: async () => record("emitAgents"),
      emitAgentUpdate: async (id: string) => record("emitAgentUpdate", id),
      emit: (event: unknown) => record("emit", event),
      resolveAgentProfile: (session: { id: string }) => ({ name: `Group ${session.id}`, description: "a group" }),
    },
    runLifecycle: {
      beginSessionRun: (session: unknown, options2?: unknown) => record("beginSessionRun", options2),
      endSessionRun: (session: unknown) => record("endSessionRun"),
      enqueueExclusiveRun: async (id: string, work: () => Promise<void>, meta: unknown) => {
        record("enqueueExclusiveRun", meta);
        return await work();
      },
      applyActivityTransition: (id: string, transition: unknown) => record("activityTransition", transition),
    },
    runnerRegistry: {
      activeGroupMemberRunners: new Map<string, unknown>(),
      runnerHooksFor: (session: unknown, transport: unknown) => ({ transport }),
      wireRunnerLifecycle: (runner: unknown, session: unknown, roomId: string) => record("wireRunnerLifecycle", roomId),
    },
    turnRuntime: { activeRequestSources: new Map<string, string>() },
    widgetResponses: {
      applyReaction: (args: unknown) => {
        record("applyReaction", args);
        return { before: { id: "t0u" }, isAdding: true };
      },
    },
    sharedRooms: {
      sharedRoomConfigOf: () => null,
      publishSharedRoomEntryIfNeeded: (session: unknown, entry: unknown) => record("publishSharedRoomEntry", (entry as { id: string }).id),
    },
    productAnalytics: { trackEvent: (name: string, properties: unknown) => record("trackEvent", name, properties) },
    trayErrors: { pushError: (error: unknown) => record("pushError", error) },
    sendPipeline: { currentTurnEpoch: () => 1 },
    xuserDelegate: undefined as unknown,
    switchAgent: async (id: string) => {
      record("switchAgent", id);
      return getTranscript();
    },
    createAgent: async (profile: unknown, origin: string) => {
      record("createAgent", profile, origin);
      return { agent: { id: "created-group" }, transcript: getTranscript() };
    },
    appendEntry: (entry: Record<string, unknown>) => {
      record("appendEntry", entry);
      setTranscript([...getTranscript(), entry as never]);
    },
  };
  const glue = new GroupChatGlue(tm as never);
  return {
    glue, tm, calls, root, directories, storeEntries,
    named: (name: string) => calls.filter((call) => call.name === name),
    lastEmitted: () => (calls.filter((call) => call.name === "emit").at(-1)?.args[0] ?? null) as { type: string; entry?: Record<string, unknown>; id?: string } | null,
  };
}

describe("which directories are groups and rooms", () => {
  it("knows a group, a room and a plain agent apart, from the directory each lives in", () => {
    const dirs = agentsDir();
    dirs.plain("plain-1");
    dirs.group("group-1");
    dirs.room("room-1");
    const world1 = world({
      directories: { "plain-1": join(dirs.root, "plain-1"), "group-1": join(dirs.root, "group-1"), "room-1": join(dirs.root, "room-1") },
    });
    assert.deepEqual([
      world1.glue.isGroupAgentId("group-1"),
      world1.glue.isGroupAgentId("plain-1"),
      world1.glue.isGroupAgentId("room-1"),
      world1.glue.isRemoteRoomAgentId("room-1"),
      world1.glue.isRemoteRoomAgentId("group-1"),
    ], [true, false, false, true, false]);
    // The same questions asked about a session are asked of the directory it was opened from.
    const groupSession = fakeSession("group-1", join(dirs.root, "group-1"));
    const plainSession = fakeSession("plain-1", join(dirs.root, "plain-1"));
    assert.deepEqual([world1.glue.isGroupSession(groupSession), world1.glue.isGroupSession(plainSession), world1.glue.isRemoteRoomSession(plainSession)], [true, false, false]);
    assert.deepEqual(world1.glue.groupIdentityFor(groupSession), { name: "Group group-1", description: "a group" });
    // And a stream starts with nothing in it.
    assert.deepEqual(createGroupMemberStream(), { currentId: undefined, currentText: "", sealed: [] });
  });

  it("pins a member's session for a room turn, and refuses one that is gone", async () => {
    const world1 = world();
    const pinned = await world1.glue.pinMemberSessionForGroupTurn("member-1");
    assert.equal(pinned.id, "member-1");
    assert.deepEqual(world1.named("beginSessionRun")[0]?.args[0], { isGroupMemberTurn: true });
    assert.deepEqual(world1.named("openSessionOnce")[0]?.args, ["member-1"]);
    // A member whose session is already open is not opened again.
    const live = fakeSession("member-1", world1.root);
    world1.tm.sessions.liveSessions.set("member-1", live);
    assert.equal(await world1.glue.pinMemberSessionForGroupTurn("member-1"), live);
    assert.equal(world1.named("openSessionOnce").length, 1);
    world1.tm.sessions.isAgentGone = () => true;
    await assert.rejects(() => world1.glue.pinMemberSessionForGroupTurn("member-2"), AgentGoneError);
  });

  it("resolves the members of a room from their directories, and leaves out what cannot be a member", async () => {
    const dirs = agentsDir();
    dirs.plain("member-1", { name: "Ada", description: "engineer" });
    dirs.plain("member-2");
    dirs.group("nested-group");
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(String(args[0]));
    };
    let world1;
    try {
      world1 = world({ directories: { "member-1": join(dirs.root, "member-1"), "member-2": join(dirs.root, "member-2"), "nested-group": join(dirs.root, "nested-group"), "gone-1": join(dirs.root, "gone-1") } });
      const remote = { ownerAuthId: "owner-1", agentId: "agent-9", name: "Remote nine" };
      const members = await world1.glue.resolveGroupMembers(["member-1", "member-2", "nested-group", "gone-1", formatRemoteAgentId(remote)], [remote as never]);
      assert.deepEqual(members, [
        { id: "member-1", name: "Ada", description: "engineer" },
        { id: "member-2", name: SLATE_DEFAULT_AGENT_NAME, description: "" },
        { id: formatRemoteAgentId(remote), name: "Remote nine", description: "" },
      ]);
    } finally {
      console.warn = originalWarn;
    }
    // A nested group is refused by name rather than being run as a member.
    assert.equal(warnings.length, 1);
    assert.match(String(warnings[0]), /ignoring nested group member/);
    // A remote id nobody vouched for is not a member at all.
    const unknownRemote = await world1.glue.resolveGroupMembers([formatRemoteAgentId({ ownerAuthId: "owner-1", agentId: "agent-8" })], []);
    assert.deepEqual(unknownRemote, []);
  });
});

describe("creating and reconfiguring a group", () => {
  it("makes a group out of the members that are there, and refuses one with nobody in it", async () => {
    const world1 = world({ agents: [{ id: "member-1" }, { id: "member-2" }, { id: "member-1" }] });
    const created = await world1.glue.createGroup({ name: "The group", description: "a description", memberIds: ["member-1", "member-2", "member-1", "nobody"] });
    assert.deepEqual(world1.named("createAgent")[0]?.args, [{ name: "The group", description: "a description" }, "user"]);
    assert.deepEqual(world1.named("trackEvent")[0]?.args, ["slate.group.created", { group_id: "created-group", member_count: 2 }]);
    assert.equal(world1.named("emitAgents").length, 1);
    // What the group is made of is written down where its own directory keeps it.
    assert.deepEqual(readSlateGroupConfig(join(world1.root, "created-group")), { version: GROUP_CONFIG_VERSION, memberIds: ["member-1", "member-2"] });
    // The roster has nothing under that id yet, so what was created is what is handed back.
    assert.deepEqual(created.agent, { id: "created-group" });
    // A roster that does have it is what is summarized.
    const refreshed = world({ agents: [{ id: "member-1" }] });
    (refreshed.tm.sessionStore as { listAgents: unknown }).listAgents = async () => [{ id: "member-1" }, { id: "created-group", name: "The group" }];
    const withRoster = await refreshed.glue.createGroup({ name: "The group", memberIds: ["member-1"] });
    assert.deepEqual(withRoster.agent, { id: "created-group", name: "The group", snapshotEpoch: "epoch", snapshotSeq: 1 });
    // A group with nothing to put in it is refused, and so is one made of another group.
    await assert.rejects(() => world1.glue.createGroup({ name: "Empty", memberIds: ["nobody"] }), SlateGroupCreateError);
    const nested = world({ agents: [{ id: "member-1" }, { id: "group-2", isGroup: true }] });
    await assert.rejects(() => nested.glue.createGroup({ name: "Nested", memberIds: ["member-1", "group-2"] }), SlateGroupNestingError);
    // Asking for a group that already has exactly these members moves to that one instead of making another.
    const existing = world({ agents: [{ id: "member-1" }, { id: "member-2" }, { id: "group-1", isGroup: true, memberIds: ["member-2", "member-1"] }] });
    const found = await existing.glue.createGroup({ name: "The group", memberIds: ["member-1", "member-2"] });
    assert.deepEqual(existing.named("switchAgent")[0]?.args, ["group-1"]);
    assert.equal(existing.named("createAgent").length, 0);
    assert.deepEqual(found.agent, { id: "group-1", isGroup: true, memberIds: ["member-2", "member-1"], snapshotEpoch: "epoch", snapshotSeq: 1 });
  });

  it("reconfigures a group's members, and leaves a room alone", async () => {
    const dirs = agentsDir();
    const groupDir = dirs.group("group-1", ["member-1"]);
    // This roster does not say which directory is a group, so nothing stops the group's own id from being asked
    // for: it is still never a member of itself.
    const world1 = world({ agents: [{ id: "member-1" }, { id: "member-2" }, { id: "group-1" }], directories: { "group-1": groupDir } });
    await world1.glue.setGroupMembers("group-1", ["member-2", "group-1", "nobody", "member-2"]);
    // The group itself and anything unknown are not members, and what is asked for is written down.
    const written = JSON.parse(readFileSync(getSlateGroupPath(groupDir), "utf8")) as { memberIds: string[]; version: number };
    assert.deepEqual([written.memberIds, written.version], [["member-2"], GROUP_CONFIG_VERSION]);
    assert.equal(world1.named("emitAgents").length, 1);
    // Nothing left to put in the group writes nothing at all.
    const before = readFileSync(getSlateGroupPath(groupDir), "utf8");
    await world1.glue.setGroupMembers("group-1", ["group-1", "nobody"]);
    assert.equal(readFileSync(getSlateGroupPath(groupDir), "utf8"), before);
    // A directory that is not a group has nothing to reconfigure.
    const plain = world({ agents: [] });
    assert.equal(await plain.glue.setGroupMembers("nothing", ["member-1"]), null);
    // A room whose members are shared belongs to whoever hosts it: its roster is handed back untouched.
    const sharedDir = dirs.group("shared-group", ["member-1"]);
    writeSlateGroupConfig(sharedDir, { version: GROUP_CONFIG_VERSION, memberIds: ["member-1"], sharedRoomId: "shared-1" });
    const shareWorld = world({ agents: [{ id: "member-1" }, { id: "member-2" }, { id: "shared-group" }], directories: { "shared-group": sharedDir } });
    const beforeShared = readFileSync(getSlateGroupPath(sharedDir), "utf8");
    const summary = await shareWorld.glue.setGroupMembers("shared-group", ["member-2"]);
    assert.deepEqual(summary, { id: "shared-group", snapshotEpoch: "epoch", snapshotSeq: 1 });
    assert.equal(readFileSync(getSlateGroupPath(sharedDir), "utf8"), beforeShared);
    assert.equal(shareWorld.named("emitAgents").length, 0);
  });
});

describe("running a room's turn", () => {
  it("runs the orchestrator over the group's members and says whether it failed", async () => {
    const dirs = agentsDir();
    const groupDir = dirs.group("group-1", ["member-1"]);
    const world1 = world({ directories: { "group-1": groupDir } });
    await world1.glue.runGroupTurn(fakeSession("group-1", groupDir), 1);
    assert.equal(world1.named("emitAgentUpdate").length, 1);
    assert.equal(world1.named("endSessionRun").length, 1);
    // A conversation that is not a group at all has no turn to run, but is still closed out.
    const plainWorld = world();
    await plainWorld.glue.runGroupTurn(fakeSession("plain-1", plainWorld.root), 1);
    assert.equal(plainWorld.named("emitAgentUpdate").length, 0);
    assert.equal(plainWorld.named("endSessionRun").length, 1);
    // A turn that failed is shown to the user and closed out like any other.
    const failing = world({ directories: { "group-1": groupDir } });
    (failing.tm.roster as { resolveAgentProfile: unknown }).resolveAgentProfile = () => {
      throw new Error("the roster is down");
    };
    await failing.glue.runGroupTurn(fakeSession("group-1", groupDir), 1);
    assert.equal((failing.named("pushError")[0]?.args[0] as Record<string, unknown>).title, "Group chat failed");
    assert.equal(failing.named("endSessionRun").length, 1);
  });

  it("hands the orchestrator what it needs to reach the room's members and what has been said", async () => {
    const dirs = agentsDir();
    const groupDir = dirs.group("group-1", ["member-1"]);
    const remote = { ownerAuthId: "owner-1", agentId: "agent-9", name: "Remote nine" };
    writeSlateGroupConfig(groupDir, { version: GROUP_CONFIG_VERSION, memberIds: ["member-1"], remoteMembers: [remote], sharedRoomId: "shared-1" });
    const entries = [{ id: "t0u", kind: "message", role: "user", content: "hello room", fromUser: { name: "Ada" } }];
    const world1 = world({ directories: { "group-1": groupDir }, entries });
    const session = fakeSession("group-1", groupDir, entries as never);
    const deps = world1.glue.groupOrchestratorDeps(session, 1);
    // A room that says it is shared says so to the orchestrator, and its turn is current while the epoch matches.
    assert.deepEqual([deps.isSharedRoom, deps.isCurrent()], [true, true]);
    world1.tm.sendPipeline.currentTurnEpoch = () => 7;
    assert.equal(deps.isCurrent(), false);
    assert.deepEqual(deps.readHistory(), [{ speaker: { kind: "user", name: "Ada" }, content: "hello room" }]);
    // Members are resolved with the remote members the group's own configuration vouches for.
    assert.deepEqual(await deps.resolveMembers([formatRemoteAgentId(remote)]), [{ id: formatRemoteAgentId(remote), name: "Remote nine", description: "" }]);
    // A member's turn asked for through the deps is a member turn: a directory with no runner attached answers nothing.
    world1.tm.execution.canExecuteGroupMember = false;
    assert.deepEqual(await deps.runMemberTurn({ member: { id: "member-1", name: "Ada", description: "" }, systemPrompt: "s", prompt: "p" }), []);
    assert.equal(world1.named("openSessionOnce").length, 0);
    assert.equal(world1.named("enqueueExclusiveRun").length, 0);
  });

  it("runs a member's turn with its own persona, streams what it says into the room, and posts it when it lands", async () => {
    const dirs = agentsDir();
    const groupDir = dirs.group("group-1", ["member-1"]);
    const memberDir = dirs.plain("member-1", { name: "Ada" });
    const groupSession = fakeSession("group-1", groupDir);
    const world1 = world({ directories: { "group-1": groupDir, "member-1": memberDir } });
    (world1.tm.sessions as { activeSession: unknown }).activeSession = groupSession;
    // The runner the glue builds is handed the transport, and says something into the room with it.
    let seenOverrides: Record<string, unknown> = {};
    let createdRunner: unknown;
    let duringRun: { stored: unknown; size: number } | undefined;
    (world1.tm.execution as { createGroupMemberRunner: unknown }).createGroupMemberRunner = (session: unknown, hooks: { transport: { onUpdate(update: unknown): void } }, overrides: Record<string, unknown>) => {
      seenOverrides = overrides;
      const runner = {
        run: async () => {
          duringRun = { stored: world1.tm.runnerRegistry.activeGroupMemberRunners.get("member-1"), size: world1.tm.runnerRegistry.activeGroupMemberRunners.size };
          hooks.transport.onUpdate({ type: "text-delta", text: "(pa" });
          hooks.transport.onUpdate({ type: "text-delta", text: "ss)" });
          hooks.transport.onUpdate({ type: "text-delta", text: "hello everyone" });
          hooks.transport.onUpdate({ type: "send-message", message: { type: "text", content: "hello everyone" } });
          return { sentMessageCount: 1, reacted: false, aborted: false };
        },
      };
      createdRunner = runner;
      return runner;
    };
    const sent = await world1.glue.runGroupMemberTurn(groupSession, { member: { id: "member-1", name: "Ada", description: "" }, systemPrompt: "you are Ada", prompt: "say hi" }, createGroupMemberStream(), () => true);
    assert.deepEqual(sent, ["hello everyone"]);
    assert.deepEqual(seenOverrides, { systemPrompt: "you are Ada", isSharedRoomTurn: false });
    // The room was shown the member speaking while it spoke, and the preview was taken away when the turn ended.
    const streamed = world1.named("emit").map((call) => call.args[0] as { type: string; entry?: { streaming?: boolean } });
    assert.equal(streamed.some((event) => event.type === "appended" && event.entry?.streaming === true), true);
    assert.deepEqual(world1.named("enqueueExclusiveRun")[0]?.args[0], { lane: "background", source: "group-member" });
    // While the member's turn ran, its runner was the one registered for that conversation; afterwards it is gone.
    assert.deepEqual([duringRun?.stored, duringRun?.size], [createdRunner, 1]);
    assert.equal(world1.tm.runnerRegistry.activeGroupMemberRunners.size, 0);
    assert.equal(world1.named("endSessionRun").length, 1);
    // A member that cannot be pinned at all says nothing rather than ending the room's turn.
    const gone = world({ directories: { "group-1": groupDir, "member-1": memberDir } });
    gone.tm.sessions.isAgentGone = () => true;
    const pinnedNowhere = await gone.glue.runGroupMemberTurn(groupSession, { member: { id: "member-1", name: "Ada", description: "" }, systemPrompt: "s", prompt: "p" }, createGroupMemberStream(), () => true);
    assert.deepEqual([pinnedNowhere, gone.named("enqueueExclusiveRun").length], [[], 0]);
  });

  it("puts the shared room's guardrail into a member's prompt and marks the turn as the room's", async () => {
    const dirs = agentsDir();
    const groupDir = dirs.group("group-1", ["member-1"]);
    const world1 = world({ directories: { "group-1": groupDir, "member-1": dirs.plain("member-1") } });
    let seenOverrides: Record<string, unknown> = {};
    (world1.tm.execution as { createGroupMemberRunner: unknown }).createGroupMemberRunner = (_session: unknown, _hooks: unknown, overrides: Record<string, unknown>) => {
      seenOverrides = overrides;
      return { run: async () => ({ sentMessageCount: 0, reacted: false, aborted: false }) };
    };
    (world1.tm.sharedRooms as { sharedRoomConfigOf: unknown }).sharedRoomConfigOf = () => ({ sharedRoomId: "shared-1", memberIds: [], remoteMembers: [] });
    await world1.glue.runGroupMemberTurn(fakeSession("group-1", groupDir), { member: { id: "member-1", name: "Ada", description: "" }, systemPrompt: "you are Ada", prompt: "p" }, createGroupMemberStream(), () => true);
    assert.deepEqual(seenOverrides, {
      systemPrompt: "you are Ada" + buildSharedRoomGuardrailPrompt({ hostName: "", isForeignHost: false }),
      isSharedRoomTurn: true,
    });
  });

  it("keeps a member's turn from failing the room, and asks again when a direct message preempted it", async () => {
    const dirs = agentsDir();
    const groupDir = dirs.group("group-1", ["member-1"]);
    const world1 = world({ directories: { "group-1": groupDir, "member-1": dirs.plain("member-1") } });
    let attempts = 0;
    (world1.tm.execution as { createGroupMemberRunner: unknown }).createGroupMemberRunner = () => ({
      run: async () => {
        attempts += 1;
        throw new Error("the member's turn broke");
      },
    });
    // A member whose turn failed says nothing, and does not fail the room.
    const quiet = await world1.glue.runGroupMemberTurn(fakeSession("group-1", groupDir), { member: { id: "member-1", name: "Ada", description: "" }, systemPrompt: "s", prompt: "p" }, createGroupMemberStream(), () => true);
    assert.deepEqual([quiet, attempts], [[], 1]);
    // A member preempted by a direct message is asked again, with a note saying the room has not seen a reply.
    const retried = world({ directories: { "group-1": groupDir, "member-1": dirs.plain("member-1") } });
    const prompts: string[] = [];
    (retried.tm.execution as { createGroupMemberRunner: unknown }).createGroupMemberRunner = () => ({ run: async (prompt: string) => { prompts.push(prompt); return { sentMessageCount: 0, reacted: false, aborted: false }; } });
    retried.glue.dmPreemptedGroupMemberIds.add("member-1");
    const nothing = await retried.glue.runGroupMemberTurn(fakeSession("group-1", groupDir), { member: { id: "member-1", name: "Ada", description: "" }, systemPrompt: "s", prompt: "say hi" }, createGroupMemberStream(), () => true);
    assert.deepEqual(nothing, []);
    assert.deepEqual(prompts, ["say hi", `say hi${buildGroupRedriveNote()}`]);
    // And one that was not preempted is asked once.
    const once = world({ directories: { "group-1": groupDir, "member-1": dirs.plain("member-1") } });
    const oncePrompts: string[] = [];
    (once.tm.execution as { createGroupMemberRunner: unknown }).createGroupMemberRunner = () => ({ run: async (prompt: string) => { oncePrompts.push(prompt); return { sentMessageCount: 0, reacted: false, aborted: false }; } });
    await once.glue.runGroupMemberTurn(fakeSession("group-1", groupDir), { member: { id: "member-1", name: "Ada", description: "" }, systemPrompt: "s", prompt: "say hi" }, createGroupMemberStream(), () => true);
    assert.deepEqual(oncePrompts, ["say hi"]);
  });

  it("answers for a member that lives on someone else's host, and only inside a shared room", async () => {
    const dirs = agentsDir();
    const roomDir = dirs.room("room-1");
    const roomSession = fakeSession("room-1", roomDir);
    const remote = { ownerAuthId: "owner-1", agentId: "agent-9", name: "Remote nine" };
    const world1 = world();
    const remoteMember = { id: formatRemoteAgentId(remote), name: "Remote nine", description: "" };
    const delegated: Array<Record<string, unknown>> = [];
    const enabledDelegate = {
      isEnabled: () => true,
      runRemoteMemberTurn: async (args: Record<string, unknown>) => {
        delegated.push(args);
        return ["from the remote member"];
      },
    };
    world1.tm.xuserDelegate = enabledDelegate;
    // A room that is not shared has nobody to reach, even though the far side could be reached.
    (world1.tm.sharedRooms as { sharedRoomConfigOf: unknown }).sharedRoomConfigOf = () => null;
    assert.deepEqual(await world1.glue.runRemoteGroupMemberTurn(roomSession, remoteMember), []);
    assert.equal(delegated.length, 0);
    // And a shared room whose far side is not enabled to speak for it is not asked either.
    world1.tm.xuserDelegate = { isEnabled: () => false, runRemoteMemberTurn: async () => ["must not be asked"] };
    (world1.tm.sharedRooms as { sharedRoomConfigOf: unknown }).sharedRoomConfigOf = () => ({ sharedRoomId: "shared-1", memberIds: ["local-1"], remoteMembers: [remote] });
    assert.deepEqual(await world1.glue.runRemoteGroupMemberTurn(roomSession, remoteMember), []);
    // The far side that is enabled to speak is asked, and told what room it is speaking in.
    world1.tm.xuserDelegate = enabledDelegate;
    const answer = await world1.glue.runRemoteGroupMemberTurn(roomSession, remoteMember);
    assert.deepEqual(answer, ["from the remote member"]);
    const args = delegated[0] ?? {};
    assert.deepEqual([args.sharedRoomId, (args.member as { id: string }).id], ["shared-1", remoteMember.id]);
    assert.deepEqual(args.group, { name: "Group room-1", description: "a group" });
    // The room is told who is speaking while the far side answers, and told again when it is over.
    assert.deepEqual(world1.named("emitAgentUpdate").length, 2);
    assert.equal(world1.glue.remoteTurnMemberIdsByRoom.has("room-1"), false);
    // Being told the same speaker twice over is not worth telling the room again.
    const announced = world1.named("emitAgentUpdate").length;
    world1.glue.setRemoteTurnMember("room-1", "member-1");
    world1.glue.setRemoteTurnMember("room-1", "member-1");
    assert.equal(world1.named("emitAgentUpdate").length, announced + 1);
    assert.equal(world1.glue.remoteTurnMemberIdsByRoom.get("room-1"), "member-1");
    world1.glue.setRemoteTurnMember("room-1");
    // A far side that failed says nothing.
    (world1.tm.xuserDelegate as { runRemoteMemberTurn: () => Promise<never> }).runRemoteMemberTurn = async () => {
      throw new Error("the other host is unreachable");
    };
    assert.deepEqual(await world1.glue.runRemoteGroupMemberTurn(roomSession, remoteMember), []);
  });

  it("does not tell the far side more than the last of what was said", async () => {
    const dirs = agentsDir();
    const roomDir = dirs.room("room-1");
    const entries = Array.from({ length: 30 }, (_, index) => ({ id: `t0u${index + 1}`, kind: "message", role: "user", content: `m${index + 1}` }));
    const roomSession = fakeSession("room-1", roomDir, entries as never);
    const remote = { ownerAuthId: "owner-1", agentId: "agent-9", name: "Remote nine" };
    const world1 = world({ entries });
    (world1.tm.sharedRooms as { sharedRoomConfigOf: unknown }).sharedRoomConfigOf = () => ({ sharedRoomId: "shared-1", memberIds: ["local-1"], remoteMembers: [remote] });
    const delegated: Array<Record<string, unknown>> = [];
    world1.tm.xuserDelegate = {
      isEnabled: () => true,
      runRemoteMemberTurn: async (args: Record<string, unknown>) => {
        delegated.push(args);
        return [];
      },
    };
    await world1.glue.runRemoteGroupMemberTurn(roomSession, { id: formatRemoteAgentId(remote), name: "Remote nine", description: "" });
    const newMessages = delegated[0]?.newMessages as Array<{ content: string }>;
    assert.equal(newMessages.length, SHARED_ROOM_HISTORY_LIMIT);
    assert.deepEqual([newMessages[0]?.content, newMessages.at(-1)?.content], ["m7", "m30"]);
  });
});

describe("what a member's talk does to the room", () => {
  it("applies a member's reaction to a message that is not its own", () => {
    const dirs = agentsDir();
    const groupDir = dirs.group("group-1", ["member-1"]);
    const other = { id: "t0u", kind: "message", role: "user", content: "hello" };
    const own = { id: "t0s1", kind: "send-message", message: { type: "text", content: "mine" }, author: { id: "member-1", name: "Ada" } };
    const legacy = { id: "legacy-1", kind: "message", role: "user", content: "from an older build" };
    const world1 = world({ directories: { "group-1": groupDir }, entries: [other, own, legacy] });
    const groupSession = fakeSession("group-1", groupDir);
    (world1.tm.sessions as { activeSession: unknown }).activeSession = groupSession;
    const member = { id: "member-1", name: "Ada", description: "" };
    assert.equal(world1.glue.applyGroupMemberReaction(groupSession, member, { emoji: "👍", messageAddress: "t0u" }), true);
    assert.equal(world1.named("applyReaction").length, 1);
    // Nothing to react to, nothing to react with, or a message of its own: none of them are reactions.
    assert.equal(world1.glue.applyGroupMemberReaction(groupSession, member, { emoji: "", messageAddress: "t0u" }), false);
    assert.equal(world1.glue.applyGroupMemberReaction(groupSession, member, { emoji: "👍", messageAddress: "not-an-address" }), false);
    assert.equal(world1.glue.applyGroupMemberReaction(groupSession, member, { emoji: "👍", messageAddress: "gone" }), false);
    assert.equal(world1.glue.applyGroupMemberReaction(groupSession, member, { emoji: "👍", messageAddress: "t0s1" }), false);
    // An entry that an address could never have named is not a message to react to either.
    assert.equal(world1.glue.applyGroupMemberReaction(groupSession, member, { emoji: "👍", messageAddress: "legacy-1" }), false);
    assert.equal(world1.named("applyReaction").length, 1);
  });

  it("writes what a member said into the room, on screen or beside it", () => {
    const dirs = agentsDir();
    const groupDir = dirs.group("group-1", ["member-1"]);
    const groupSession = fakeSession("group-1", groupDir);
    const world1 = world({ directories: { "group-1": groupDir } });
    (world1.tm.sessions as { activeSession: unknown }).activeSession = groupSession;
    world1.glue.postGroupMemberMessage(groupSession, { id: "member-1", name: "Ada", description: "" }, "hello everyone");
    const entry = getTranscript()[0] as Record<string, unknown>;
    assert.deepEqual([entry.kind, entry.message, entry.author], ["send-message", { type: "text", content: "hello everyone" }, { id: "member-1", name: "Ada" }]);
    assert.deepEqual(world1.named("publishSharedRoomEntry")[0]?.args, [entry.id]);
    // A conversation that is not on screen gets its own entry and its roster refreshed.
    const side = world({ directories: { "group-1": groupDir } });
    const sideSession = fakeSession("group-1", groupDir);
    side.glue.postGroupMemberMessage(sideSession, { id: "member-1", name: "Ada", description: "" }, "said quietly");
    assert.equal(side.named("appendEntry").length, 0);
    assert.equal((sideSession.db.getTranscriptEntries()[0] as Record<string, unknown>).message && ((sideSession.db.getTranscriptEntries()[0] as Record<string, unknown>).message as { content: string }).content, "said quietly");
    assert.equal(side.named("markSessionActivity").length, 1);
    assert.equal(side.named("emitAgentUpdate").length, 1);
    // A preview the room is already watching becomes the message itself rather than a second entry.
    const streamed = world({ directories: { "group-1": groupDir } });
    (streamed.tm.sessions as { activeSession: unknown }).activeSession = groupSession;
    const live = createGroupMemberStream();
    const member = { id: "member-1", name: "Ada", description: "" };
    streamed.glue.streamGroupMemberUpdate(groupSession, member, { type: "text-delta", text: "hello" }, live);
    streamed.glue.streamGroupMemberUpdate(groupSession, member, { type: "send-message", message: { type: "text", content: "hello" } }, live);
    streamed.glue.postGroupMemberMessage(groupSession, member, "hello", live);
    const finalized = streamed.lastEmitted();
    assert.deepEqual([finalized?.type, (finalized?.entry?.message as unknown as { content: string } | undefined)?.content], ["updated", "hello"]);
    assert.equal(streamed.named("markActiveSessionArrival").length, 1);
    assert.equal(streamed.named("publishSharedRoomEntry").length, 1);
    assert.deepEqual([live.sealed.length, live.currentId], [0, undefined]);
  });

  it("shows a member talking as it talks, and takes the preview away when the turn is done", () => {
    const dirs = agentsDir();
    const groupDir = dirs.group("group-1", ["member-1"]);
    const groupSession = fakeSession("group-1", groupDir);
    const world1 = world({ directories: { "group-1": groupDir } });
    (world1.tm.sessions as { activeSession: unknown }).activeSession = groupSession;
    const member = { id: "member-1", name: "Ada", description: "" };
    const live = createGroupMemberStream();
    // A prefix that could still turn out to be a pass is not shown at all.
    world1.glue.streamGroupMemberUpdate(groupSession, member, { type: "text-delta", text: "(pa" }, live);
    assert.equal(live.currentId, undefined);
    // Once it is clearly not a pass, the room is shown the member speaking.
    world1.glue.streamGroupMemberUpdate(groupSession, member, { type: "text-delta", text: "hello" }, live);
    const opened = world1.lastEmitted();
    assert.deepEqual([opened?.type, opened?.entry?.streaming, (opened?.entry?.message as unknown as { content: string } | undefined)?.content], ["appended", true, "(pahello"]);
    world1.glue.streamGroupMemberUpdate(groupSession, member, { type: "text-delta", text: " there" }, live);
    assert.equal((world1.lastEmitted()?.entry?.message as unknown as { content: string } | undefined)?.content, "(pahello there");
    // What was sent seals the preview, and finishing the turn takes every preview away.
    world1.glue.streamGroupMemberUpdate(groupSession, member, { type: "send-message", message: { type: "text", content: "hello there" } }, live);
    assert.deepEqual(live.sealed.length, 1);
    assert.equal(live.currentId, undefined);
    world1.glue.finalizeGroupMemberStream(groupSession, live);
    assert.equal(world1.lastEmitted()?.type, "removed");
    assert.deepEqual([live.currentId, live.currentText, live.sealed], [undefined, "", []]);
    // A room that is not on screen is not streamed into at all.
    const side = world({ directories: { "group-1": groupDir } });
    side.glue.streamGroupMemberUpdate(groupSession, member, { type: "text-delta", text: "hello" }, createGroupMemberStream());
    assert.equal(side.named("emit").length, 0);
  });

  it("reads the room's history as what was said and who said it", () => {
    const dirs = agentsDir();
    const groupDir = dirs.group("group-1", ["member-1"]);
    const entries = [
      { id: "t0u", kind: "message", role: "user", content: "hello room", fromUser: { name: "Ada" } },
      { id: "t0u2", kind: "message", role: "user", content: "and hello again" },
      { id: "t0u3", kind: "message", role: "user", content: "   " },
      { id: "t0s1", kind: "send-message", message: { type: "text", content: "from Ada" }, author: { id: "member-1", name: "Ada" } },
      { id: "t0s2", kind: "send-message", message: { type: "text", content: "still typing" }, author: { id: "member-2", name: "Bo" }, streaming: true },
      { id: "t0s3", kind: "send-message", message: { type: "connector", connector: "slack" } },
    ];
    const world1 = world({ directories: { "group-1": groupDir }, entries });
    const groupSession = fakeSession("group-1", groupDir, entries as never);
    (world1.tm.sessions as { activeSession: unknown }).activeSession = groupSession;
    assert.deepEqual(world1.glue.readGroupHistory(groupSession), [
      { speaker: { kind: "user", name: "Ada" }, content: "hello room" },
      { speaker: { kind: "user" }, content: "and hello again" },
      { speaker: { kind: "member", id: "member-1", name: "Ada" }, content: "from Ada" },
    ]);
    assert.equal(SHARED_ROOM_HISTORY_LIMIT, 24);
    void GROUP_MAX_MEMBERS;
  });
});

// ---------------------------------------------------------------------------------------------
// The edges a group turn is told about

describe("the edges a group turn is told about", () => {
  it("brings forward the group whose members match exactly, not any other group", async () => {
    const world1 = world({ agents: [
      { id: "g-other", isGroup: true, memberIds: ["m2"] },
      { id: "m1" },
      { id: "match", isGroup: true, memberIds: ["m1"] },
    ] });
    const result = await world1.glue.createGroup({ name: "Same members", memberIds: ["m1"] });
    assert.deepEqual(world1.named("switchAgent").map((call) => call.args[0]), ["match"]);
    assert.equal(result.transcript != null, true);
    const reordered = await world1.glue.createGroup({ name: "Same again", memberIds: ["m1"] });
    assert.deepEqual(reordered.agent.id, "match");
  });

  it("says whether the room behind a turn is a shared room", () => {
    const dirs = agentsDir();
    const groupDir = dirs.group("group", []);
    writeSlateGroupConfig(groupDir, { version: GROUP_CONFIG_VERSION, memberIds: [], sharedRoomId: "room-1" });
    const world1 = world({ directories: { group: groupDir } });
    const session = { id: "group", dbPath: join(groupDir, "store.db") };
    assert.equal(world1.glue.groupOrchestratorDeps(session, 1).isSharedRoom, true);
    writeSlateGroupConfig(groupDir, { version: GROUP_CONFIG_VERSION, memberIds: [] });
    assert.equal(world1.glue.groupOrchestratorDeps(session, 1).isSharedRoom, false);
  });

  it("sends a remote member's turn to the far side instead of running it locally", async () => {
    const dirs = agentsDir();
    const groupDir = dirs.group("group", ["m1"]);
    const world1 = world({ directories: { group: groupDir } });
    const remoteId = formatRemoteAgentId({ ownerAuthId: "owner", agentId: "agent" });
    const session = { id: "group", dbPath: join(groupDir, "store.db") };
    const remote = await world1.glue.runGroupMemberTurn(session, { member: { id: remoteId, name: "Remote", description: "" }, systemPrompt: "s", prompt: "p" }, { currentId: undefined, currentText: "", sealed: [] }, () => true);
    assert.deepEqual(remote, []);
    assert.equal(world1.named("createGroupMemberRunner").length, 0);
  });

  it("applies a member's reaction while its turn runs", async () => {
    const dirs = agentsDir();
    const groupDir = dirs.group("group", ["m1"]);
    const world1 = world({ directories: { group: groupDir }, entries: [{ id: "t0u", kind: "message", role: "user", content: "hi" }] });
    const session = fakeSession("group", groupDir);
    (world1.tm.sessions as { activeSession: unknown }).activeSession = session;
    (world1.tm.execution as { createGroupMemberRunner: unknown }).createGroupMemberRunner = (_session: unknown, hooks: { transport: { onUpdate(update: unknown): void } }) => ({
      run: async () => {
        hooks.transport.onUpdate({ type: "react-to-message", emoji: "x", messageAddress: "t0u" });
        return { sentMessageCount: 1, reacted: true, aborted: false };
      },
    });
    await world1.glue.runGroupMemberTurn(session, { member: { id: "m1", name: "Member", description: "" }, systemPrompt: "s", prompt: "p" }, { currentId: undefined, currentText: "", sealed: [] }, () => true);
    assert.deepEqual((world1.named("applyReaction")[0]?.args[0] as { emoji: string }).emoji, "x");
  });

  it("stops asking a preempted member after the third try", async () => {
    const dirs = agentsDir();
    const groupDir = dirs.group("group", ["m1"]);
    const world1 = world({ directories: { group: groupDir } });
    const session = { id: "group", dbPath: join(groupDir, "store.db") };
    let runs = 0;
    (world1.tm.execution as { createGroupMemberRunner: unknown }).createGroupMemberRunner = () => ({
      run: async () => {
        runs += 1;
        world1.glue.dmPreemptedGroupMemberIds.add("m1");
        return { sentMessageCount: 0, reacted: false, aborted: false };
      },
    });
    await world1.glue.runGroupMemberTurn(session, { member: { id: "m1", name: "Member", description: "" }, systemPrompt: "s", prompt: "p" }, { currentId: undefined, currentText: "", sealed: [] }, () => true);
    assert.equal(runs, 3);
  });

  it("leaves the member itself out of the peers it tells the far side about", async () => {
    const dirs = agentsDir();
    const groupDir = dirs.group("group", ["m1", "m2"]);
    writeSlateGroupConfig(groupDir, { version: GROUP_CONFIG_VERSION, memberIds: ["m1", "m2"], sharedRoomId: "room-1", remoteMembers: [{ ownerAuthId: "o", agentId: "a", name: "Remote" }] });
    const world1 = world({ directories: { group: groupDir } });
    const remoteId = formatRemoteAgentId({ ownerAuthId: "o", agentId: "a" });
    (world1.tm.sharedRooms as { sharedRoomConfigOf: () => unknown }).sharedRoomConfigOf = () => ({ sharedRoomId: "room-1", memberIds: [remoteId, "m1"], remoteMembers: [{ ownerAuthId: "o", agentId: "a", name: "Remote" }] });
    const requests: Array<{ peers: Array<{ id: string }> }> = [];
    (world1.tm as { xuserDelegate: unknown }).xuserDelegate = { isEnabled: () => true, runRemoteMemberTurn: async (request2: { peers: Array<{ id: string }> }) => { requests.push(request2); return ["ok"]; } };
    const session = fakeSession("group", groupDir);
    await world1.glue.runRemoteGroupMemberTurn(session, { id: remoteId, name: "Remote", description: "" });
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0]?.peers.map((peer) => peer.id).includes(remoteId), false);
  });

  it("does not open a preview for an empty streamed delta", () => {
    const world1 = world();
    (world1.tm.sessions as { activeSession: unknown }).activeSession = { id: "group" };
    const stream = createGroupMemberStream();
    world1.glue.streamGroupMemberUpdate({ id: "group" }, { id: "m1", name: "Member", description: "" }, { type: "text-delta" }, stream);
    assert.equal(stream.currentId, undefined);
    assert.equal(world1.named("appendEntry").length, 0);
  });
});
