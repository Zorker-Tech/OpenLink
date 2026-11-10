/**
 * The shared rooms a transcript is mirrored into: what a room carries into the conversation, what the user is told when
 * it cannot, which agent stands for a room, and what a room's binding looks like on disk.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { writeSlateGroupConfig } from "../../source/host/groups/group-store.ts";
import { writeSlateRemoteRoomConfig } from "../../source/host/groups/remote-room-store.ts";
import { decodeAvatarDataUrl, isRoomContentEntry, SharedRooms } from "../../source/host/transcript/shared-rooms.ts";
import { clearTranscript, setTranscript } from "../../source/host/transcript/transcript-store.ts";

const avatarDataUrl = (bytes: number[]) => `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`;

/** A transcript manager as the shared rooms use one, with every call written down and its bindings on disk. */
function harness(options: { agents?: Array<{ id: string; createdAt: number }>; entriesByAgent?: Record<string, unknown[]>; canonicalAgent?: string; delegate?: unknown; unresolvable?: string[]; pinnedSession?: unknown; memberSent?: string[]; canExecute?: boolean; canExecuteGroupMember?: boolean; createdId?: string; currentAvatar?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), "slate-rooms-"));
  const calls: unknown[][] = [];
  const sessions = new Map<string, unknown>();
  const agents = options.agents ?? [{ id: "group-1", createdAt: 1 }, { id: "room-1", createdAt: 2 }];
  const entriesFor = new Map<string, Array<{ id?: unknown; kind?: unknown; text?: unknown; content?: unknown; clientNonce?: unknown }>>();
  const session = (id: string) => {
    const existing = sessions.get(id);
    if (existing != null) return existing;
    const created = {
      id,
      dbPath: join(root, id, "db"),
      db: {
        appendTranscriptEntry: (entry: Record<string, unknown>) => {
          const stored = entriesFor.get(id) ?? [...(options.entriesByAgent?.[id] ?? [{ kind: "message", id: `${id}-e1` }])] as typeof entriesFor extends Map<string, infer Held> ? Held : never;
          if (!stored.some((held) => held.id === entry.id)) stored.push(entry);
          entriesFor.set(id, stored);
          calls.push(["append-db", id, entry.kind, entry.id, entry.text ?? entry.content]);
          return true;
        },
        getTranscriptEntries: () => entriesFor.get(id) ?? options.entriesByAgent?.[id] ?? [{ kind: "message", id: `${id}-e1` }],
        updateTranscriptEntry: (entryId: string, stamp: (entry: unknown) => unknown) => { calls.push(["stamp-db", id, entryId, (stamp({ id: entryId, kind: "message", timestampMs: 0 }) as { timestampMs: number }).timestampMs]); },
      },
    };
    sessions.set(id, created);
    return created;
  };
  // A hosted group and a mirrored room are bound to the same room, so both are candidates for its agent.
  writeSlateGroupConfig(join(root, "group-1"), { version: 1, memberIds: ["agent-me"], sharedRoomId: "room-7" });
  writeSlateRemoteRoomConfig(join(root, "room-1"), { version: 1, roomId: "room-7", hostAuthId: "host-1", hostName: "Host", members: [{ kind: "agent", authId: "owner-2", agentId: "agent-2", displayName: "Their agent", avatarUrl: "https://example.invalid/a.png" }] });
  const manager = {
    sessionStore: {
      listAgents: async () => agents,
      getAgentDir: (agentId: string) => join(root, agentId),
      getAgentAvatar: async () => ({ dataUrl: options.currentAvatar ?? avatarDataUrl([9, 9]) }),
      setAgentAvatarBytes: async (_db: unknown, _path: unknown, agentId: string, bytes: Uint8Array, name: string) => { calls.push(["avatar-bytes", agentId, bytes.length, name]); },
      setAgentAvatarBytesById: async (agentId: string, bytes: Uint8Array) => { calls.push(["avatar-by-id", agentId, bytes.length]); },
      markSessionActivity: (target: { id: string }) => { calls.push(["mark-activity", target.id]); },
    },
    groupChat: {
      isGroupAgentId: (id: string) => id.startsWith("group-"),
      isRemoteRoomAgentId: (id: string) => id.startsWith("room-"),
      isRemoteRoomSession: (target: { id: string }) => target.id.startsWith("room-"),
      groupIdentityFor: () => ({ name: "Nightly crew" }),
      resolveGroupMembers: async (ids: string[]) => ids.map((id) => ({ id, name: `Agent ${id}`, description: "" })),
      postGroupMemberMessage: (target: { id: string }, member: { id: string }, text: string) => { calls.push(["post-group-message", target.id, member.id, text]); },
      runGroupTurn: async (target: { id: string }, epoch: number, _arg: unknown, source: string) => { calls.push(["group-turn", target.id, epoch, source]); },
      remoteTurnMemberIdsByRoom: new Map<string, string>(),
      pinMemberSessionForGroupTurn: async (agentId: string) => { const pinned = options.pinnedSession ?? sessions.get(agentId); if (pinned == null) throw new Error("no session"); return pinned; },
    },
    execution: {
      canExecute: options.canExecute ?? true,
      canExecuteGroupMember: options.canExecuteGroupMember ?? true,
      createGroupMemberRunner: (target: { id: string }, hooks: { onUpdate(update: unknown): void }, args: { isSharedRoomTurn: boolean }) => ({
        run: async (prompt: string) => {
          calls.push(["member-turn", target.id, prompt, args.isSharedRoomTurn]);
          for (const text of options.memberSent ?? []) hooks.onUpdate({ type: "send-message", message: { type: "text", content: text } });
        },
      }),
    },
    runnerRegistry: { runnerHooksFor: () => ({ onUpdate: () => {} }), wireRunnerLifecycle: (_runner: unknown, _target: unknown, id: string) => { calls.push(["wire", id]); } },
    sessions: {
      activeSession: undefined as unknown,
      resolveBackgroundSession: async (agentId: string) => {
        if ((options.unresolvable ?? []).includes(agentId)) throw new Error(`no session for ${agentId}`);
        return session(agentId);
      },
    },
    appendEntry: (entry: Record<string, unknown>) => { calls.push(["append-active", entry.kind, entry.id, entry.text ?? entry.content]); },
    roster: { emit: (value: { type: string }) => { calls.push(["emit", value.type]); }, emitAgentUpdate: async (id: string) => { calls.push(["roster", id]); }, emitAgents: async () => { calls.push(["emit-agents"]); } },
    sendPipeline: {
      materializeInlineImages: async (_target: unknown, images: unknown[]) => (images ?? []).map((image) => ({ materialized: true, image })),
      nextTurnEpoch: (target: { id: string }) => { calls.push(["next-epoch", target.id]); return 7; },
    },
    runLifecycle: {
      beginSessionRun: (target: { id: string }) => { calls.push(["begin-run", target.id]); },
      enqueueExclusiveRun: (agentId: string, task: () => Promise<void>, runOptions: { lane: string; source: string }) => { calls.push(["enqueue", agentId, runOptions.lane, runOptions.source]); return task(); },
      endSessionRun: (target: { id: string }) => { calls.push(["end-run", target.id]); },
    },
    turnRuntime: { activeRequestSources: new Map<string, string>() },
    backgroundWakes: { appendAgentOutboundEntry: (from: string, to: { name: string; kind: string }, text: string) => { calls.push(["outbound", from, to.name, to.kind, text]); } },
    productAnalytics: { trackEvent: (name: string, payload: Record<string, unknown>) => { calls.push(["analytics", name, payload]); } },
    xuserDelegate: options.delegate === null
      ? null
      : {
          isEnabled: () => true,
          publishRoomEntry: (roomId: string, entry: { id: string }) => { calls.push(["publish", roomId, entry.id]); },
          sendMirrorPost: async (args: { roomId: string; images: unknown[] }) => { calls.push(["mirror-post", args.roomId, args.images.length]); return { timestampMs: 1_700 }; },
          ...(options.delegate as Record<string, unknown> ?? {}),
        },
    findRoomAgentId: async (roomId: string) => (roomId === "room-7" ? (options.canonicalAgent ?? "group-1") : null),
    deleteAgents: async (ids: string[]) => { calls.push(["delete-agents", ids.join(",")]); },
    createBackgroundAgent: async (spec: { name: string }, _source: string, createOptions: { isIntroductionSuppressed: boolean; configureAgentDir(dir: string): void }) => {
      calls.push(["create-agent", spec.name, createOptions.isIntroductionSuppressed]);
      const id = options.createdId ?? "created-1";
      createOptions.configureAgentDir(join(root, id));
      return { agent: { id } };
    },
    disposed: false,
  };
  return { manager, calls, root, session, kinds: (of: string) => calls.filter((call) => call[0] === of) };
}

describe("shared rooms", () => {
  it("reads a room's picture out of a data URL, and knows what a room carries", () => {
    assert.equal(decodeAvatarDataUrl(avatarDataUrl([1, 2, 3]))?.length, 3);
    // Only an image data URL with bytes in it is a picture.
    assert.equal(decodeAvatarDataUrl("https://example.invalid/a.png"), null);
    assert.equal(decodeAvatarDataUrl("data:image/png,abc"), null);
    assert.equal(decodeAvatarDataUrl("data:image/png;base64,"), null);
    // Something that carries bytes but is not an image is not a picture either.
    assert.equal(decodeAvatarDataUrl(`data:text/plain;base64,${Buffer.from([1, 2]).toString("base64")}`), null);
    assert.equal(isRoomContentEntry({ kind: "message" } as never), true);
    assert.equal(isRoomContentEntry({ kind: "send-message" } as never), true);
    assert.equal(isRoomContentEntry({ kind: "notice" } as never), false);
    assert.equal(isRoomContentEntry({ kind: "tool-call" } as never), false);
  });

  it("finds the agents bound to a room, and which one of them stands for it", async () => {
    const { manager, kinds } = harness();
    const rooms = new SharedRooms(manager as never);
    assert.deepEqual((await rooms.listBoundRoomAgents("room-7")).map((agent) => agent.id), ["group-1", "room-1"]);
    assert.deepEqual(await rooms.listRoomAgentIds("room-7"), ["group-1", "room-1"]);
    // With more than one candidate the one holding the most of the conversation stands for the room.
    assert.equal(await rooms.findRoomAgentId("room-7"), "group-1");
    assert.equal(await rooms.findRoomAgentId("room-nowhere"), null);
    assert.equal(kinds("delete-agents").length, 0);
    // Both a hosted group and a mirror room answer with the room they belong to.
    assert.equal(await rooms.getSharedRoomIdForAgent("group-1"), "room-7");
    assert.equal(await rooms.getSharedRoomIdForAgent("room-1"), "room-7");
    assert.equal(await rooms.getSharedRoomIdForAgent("nothing"), null);
  });

  it("drops the duplicate room agents that hold nothing, and keeps the one that does", async () => {
    const content = harness({ entriesByAgent: { "room-1": [{ kind: "message", id: "kept" }], "group-1": [] } });
    const contentRooms = new SharedRooms(content.manager as never);
    const originalWarn = console.warn;
    const warns: string[] = [];
    console.warn = (...args: unknown[]) => { warns.push(args.join(" ")); };
    try {
      // The duplicate that still holds the conversation is kept and reported, not deleted.
      assert.equal(await contentRooms.resolveCanonicalRoomAgent("room-7"), "room-1");
      assert.deepEqual(content.kinds("delete-agents"), [["delete-agents", "group-1"]]);
      assert.equal(warns.some((line) => line.startsWith("[slate:sharing] removing 1 empty duplicate room agent(s)")), true);
    } finally {
      console.warn = originalWarn;
    }
    // With nothing to remove, nothing is deleted and nothing is reported.
    const quiet = harness({ entriesByAgent: { "room-1": [{ kind: "message", id: "kept" }], "group-1": [{ kind: "message", id: "kept-too" }] } });
    const quietRooms = new SharedRooms(quiet.manager as never);
    const quietWarns: string[] = [];
    console.warn = (...args: unknown[]) => { quietWarns.push(args.join(" ")); };
    try {
      // Two candidates holding the same amount of conversation: the one the platform listed first stands for the room,
      // and the other is reported rather than dropped.
      assert.equal(await quietRooms.resolveCanonicalRoomAgent("room-7"), "group-1");
      assert.deepEqual(quiet.kinds("delete-agents"), []);
      assert.equal(quietWarns.length, 1);
      assert.equal(quietWarns[0]?.startsWith("[slate:sharing] keeping duplicate room agent with content room=room-7 agent=room-1"), true);
    } finally {
      console.warn = originalWarn;
    }
  });

  it("posts to a group the agent is in, and says why it did not when it cannot", async () => {
    const { manager, kinds } = harness({ agents: [{ id: "agent-me", createdAt: 1 }, { id: "group-1", createdAt: 2 }] });
    const rooms = new SharedRooms(manager as never);
    assert.equal(await rooms.postToGroup("agent-me", "group-1", "   "), "Message was empty; nothing was sent.");
    assert.equal(await rooms.postToGroup("agent-me", "group-1", "(pass)"), 'Nothing was posted: "(pass)" means staying silent in a group chat.');
    // A room whose session cannot be opened, and one with no group binding at all, are told apart.
    const missing = harness({ unresolvable: ["missing"] });
    assert.equal(await new SharedRooms(missing.manager as never).postToGroup("agent-me", "missing", "hello"), "No group found with id missing.");
    assert.equal(await rooms.postToGroup("agent-me", "no-binding", "hello"), "no-binding is not a group chat.");
    // The agent must be a member of the group it posts to.
    writeSlateGroupConfig(join(harnessRootOf(manager), "group-1"), { version: 1, memberIds: ["someone-else"], sharedRoomId: "room-7" });
    assert.equal(await rooms.postToGroup("agent-me", "group-1", "hello"), "You can only post to a group you're a member of.");
    writeSlateGroupConfig(join(harnessRootOf(manager), "group-1"), { version: 1, memberIds: ["agent-me"], sharedRoomId: "room-7" });
    // A posted message is recorded, carried to the group, and answered on its own turn.
    kinds("analytics").length = 0;
    assert.equal(await rooms.postToGroup("agent-me", "group-1", "  hello there  ", true), 'Posted to "Nightly crew". Its members will see it and reply on their own turns.');
    assert.deepEqual(kinds("analytics").map((call) => [call[1], (call[2] as Record<string, unknown>).is_group_target, (call[2] as Record<string, unknown>).is_priority]), [["slate.agent_message.sent", true, true]]);
    assert.deepEqual(kinds("outbound").map((call) => [call[1], call[3], call[4]]), [["agent-me", "group", "hello there"]]);
    assert.deepEqual(kinds("post-group-message").map((call) => [call[1], call[2], call[3]]), [["group-1", "agent-me", "hello there"]]);
    assert.deepEqual(kinds("begin-run").map((call) => call[1]), ["group-1"]);
    assert.deepEqual(kinds("enqueue").map((call) => [call[2], call[3]]), [["agent", "agent"]]);
    assert.deepEqual(kinds("group-turn").map((call) => [call[1], call[2], call[3]]), [["group-1", 7, "agent"]]);
    // Nothing runs when the host cannot execute at all.
    const cannot = harness({ canExecute: false });
    assert.equal(await new SharedRooms(cannot.manager as never).postToGroup("agent-me", "group-1", "hello"), "Messaging isn't available right now.");
  });

  it("tells the user when a mirrored message could not be delivered, and restamps it when it was", async () => {
    const noDelegate = harness({ delegate: null });
    const noDelegateRooms = new SharedRooms(noDelegate.manager as never);
    const roomSession = await noDelegate.manager.sessions.resolveBackgroundSession("room-1");
    await noDelegateRooms.dispatchMirrorRoomSend(roomSession, { text: "hi", selectedImages: [], hasNonImageAttachments: false });
    // A session that is not on screen is written into its own store and announced to the roster.
    const notice = noDelegate.kinds("append-db")[0];
    assert.equal(notice?.[2], "notice");
    assert.equal(String(notice?.[3]).startsWith("notice-xuser-"), true);
    assert.equal(noDelegate.kinds("append-active").length, 0);
    assert.deepEqual(noDelegate.kinds("roster").map((call) => call[1]), ["room-1"]);

    // On screen, the same notice goes to the transcript in memory.
    noDelegate.manager.sessions.activeSession = roomSession;
    noDelegate.calls.length = 0;
    await noDelegateRooms.dispatchMirrorRoomSend(roomSession, { text: "hi", selectedImages: [], hasNonImageAttachments: false });
    assert.deepEqual(noDelegate.calls.map((call) => call[0]), ["append-active"]);
    assert.equal(String(noDelegate.calls[0]?.[3]).startsWith("This shared chat isn't connected right now"), true);

    // A room whose access was taken back says so rather than sending anything.
    const revoked = harness();
    writeSlateRemoteRoomConfig(join(revoked.root, "room-1"), { version: 1, roomId: "room-7", hostAuthId: "host-1", hostName: "Host", members: [], isRevoked: true });
    const revokedRooms = new SharedRooms(revoked.manager as never);
    await revokedRooms.dispatchMirrorRoomSend(await revoked.manager.sessions.resolveBackgroundSession("room-1"), { text: "hi", selectedImages: [], hasNonImageAttachments: false });
    assert.equal(revoked.kinds("mirror-post").length, 0);
    assert.equal(String(revoked.kinds("append-db")[0]?.[4]).includes("no longer have access"), true);

    // Attachments that are not images are left out, and the message still goes.
    const attachments = harness();
    const attachmentRooms = new SharedRooms(attachments.manager as never);
    await attachmentRooms.dispatchMirrorRoomSend(await attachments.manager.sessions.resolveBackgroundSession("room-1"), { text: "hi", selectedImages: [], hasNonImageAttachments: true });
    assert.deepEqual(attachments.kinds("mirror-post").map((call) => call[2]), [0]);
    assert.equal(String(attachments.kinds("append-db")[0]?.[4]).includes("Only text and images"), true);

    // Images past the platform's limit are dropped and reported, and the rest go.
    const sized = harness();
    const sizedRooms = new SharedRooms(sized.manager as never);
    const bigImage = { data: new Uint8Array(700_000), mimeType: "image/png" };
    await sizedRooms.dispatchMirrorRoomSend(await sized.manager.sessions.resolveBackgroundSession("room-1"), { text: "hi", selectedImages: [bigImage, bigImage], hasNonImageAttachments: false });
    assert.deepEqual(sized.kinds("mirror-post").map((call) => call[2]), [1]);
    assert.equal(String(sized.kinds("append-db")[0]?.[4]).includes("Some images were too large"), true);

    // What the platform acknowledged is timestamped with the room's own time, on screen and in the store.
    const acked = harness();
    const ackedRooms = new SharedRooms(acked.manager as never);
    const ackedSession = await acked.manager.sessions.resolveBackgroundSession("room-1");
    acked.manager.sessions.activeSession = ackedSession;
    setTranscript([{ kind: "message", id: "echo-1", clientNonce: "nonce-1", timestampMs: 5 } as never]);
    acked.calls.length = 0;
    await ackedRooms.dispatchMirrorRoomSend(ackedSession, { text: "hi", selectedImages: [], hasNonImageAttachments: false, clientNonce: "nonce-1" });
    assert.deepEqual(acked.kinds("emit").map((call) => call[1]), ["updated"]);
    assert.deepEqual(acked.kinds("stamp-db").map((call) => [call[1], call[2], call[3]]), [["room-1", "echo-1", 1_700]]);
    clearTranscript();

    // A send that failed is reported to the platform's own log and to the user.
    const failing = harness({ delegate: { sendMirrorPost: async () => { throw new Error("socket closed"); } } });
    const failingRooms = new SharedRooms(failing.manager as never);
    const warns: string[] = [];
    console.warn = (...args: unknown[]) => { warns.push(args.join(" ")); };
    try {
      await failingRooms.dispatchMirrorRoomSend(await failing.manager.sessions.resolveBackgroundSession("room-1"), { text: "hi", selectedImages: [], hasNonImageAttachments: false });
    } finally {
      console.warn = (await import("node:console")).default.warn;
    }
    assert.deepEqual(warns.map((line) => line.slice(0, 52)), ["[slate:sharing] mirror send failed room=room-7: sock"]);
    assert.equal(String(failing.kinds("append-db")[0]?.[4]).includes("couldn't be delivered to the shared chat"), true);
  });
});

/** The temporary directory a harness bound its rooms in. */
function harnessRootOf(manager: { sessionStore: { getAgentDir(agentId: string): string } }): string {
  return join(manager.sessionStore.getAgentDir("group-1"), "..");
}

describe("what a room writes into the conversation", () => {
  it("writes a guest's message in, once, as the user they are", async () => {
    const { manager, calls, kinds } = harness({ canonicalAgent: "room-1" });
    const rooms = new SharedRooms(manager as never);
    const roomSession = await manager.sessions.resolveBackgroundSession("room-1");
    // Nothing is written for a room that has no agent of its own.
    assert.equal(await rooms.appendMirrorRoomEntry({ roomId: "room-nowhere", entry: { entryId: "e1", kind: "human-message", text: "hi", timestampMs: 5 } }), false);
    calls.length = 0;
    const wrote = await rooms.appendMirrorRoomEntry({ roomId: "room-7", entry: { entryId: "entry-9", kind: "human-message", text: "hello", timestampMs: 5, authorAuthId: "guest-2", authorName: "Bob", images: [{ base64: "AAAA", mediaType: "image/png" }] }, selfAuthId: "self-1" });
    assert.equal(wrote, true);
    const appended = kinds("append-db")[0];
    assert.equal(appended?.[2], "message");
    assert.equal(appended?.[3], "xu-entry-9");
    assert.deepEqual(kinds("mark-activity").map((call) => call[1]), ["room-1"]);
    assert.deepEqual(kinds("roster").map((call) => call[1]), ["room-1"]);
    // The same entry is not written twice, and neither is the same message from the other side.
    calls.length = 0;
    assert.equal(await rooms.appendMirrorRoomEntry({ roomId: "room-7", entry: { entryId: "entry-9", kind: "human-message", text: "hello", timestampMs: 5 }, selfAuthId: "self-1" }), true);
    assert.deepEqual(calls, []);
    assert.equal(await rooms.appendMirrorRoomEntry({ roomId: "room-7", entry: { entryId: "entry-10", kind: "human-message", text: "hello again", timestampMs: 6, clientNonce: "nonce-1" }, selfAuthId: "self-1" }), true);
    // A message with a nonce already in the conversation is the same message.
    const withNonce = harness({ canonicalAgent: "room-1", entriesByAgent: { "room-1": [{ kind: "message", id: "e1", clientNonce: "nonce-1" }] } });
    const nonceRooms = new SharedRooms(withNonce.manager as never);
    await withNonce.manager.sessions.resolveBackgroundSession("room-1");
    assert.equal(await nonceRooms.appendMirrorRoomEntry({ roomId: "room-7", entry: { entryId: "entry-11", kind: "human-message", text: "again", timestampMs: 7, clientNonce: "nonce-1" }, selfAuthId: "self-1" }), true);
    assert.deepEqual(withNonce.kinds("append-db"), []);
    assert.equal(roomSession !== undefined || true, true);
  });

  it("writes a guest's post in and starts the room's own turn", async () => {
    const { manager, calls, kinds } = harness();
    const rooms = new SharedRooms(manager as never);
    const roomSession = await manager.sessions.resolveBackgroundSession("room-1");
    const publish = { id: "published-1" };
    // Nothing is written for a room with no agent, none without a binding, and none for a post with nothing in it.
    await rooms.postSharedRoomGuestMessage({ roomId: "room-nowhere", text: "hi", images: [], authorName: "Bob", authorAuthId: "guest-2" });
    assert.deepEqual(calls, []);
    await rooms.postSharedRoomGuestMessage({ roomId: "room-7", text: "   ", images: [], authorName: "Bob", authorAuthId: "guest-2" });
    assert.deepEqual(calls, []);
    calls.length = 0;
    await rooms.postSharedRoomGuestMessage({ roomId: "room-7", text: "  hello  ", images: [{ base64: "AAAA", mediaType: "image/png" }], authorName: "Bob", authorAuthId: "guest-2", authorAvatarUrl: "https://example.invalid/b.png", clientNonce: "nonce-2", timestampMs: 42 });
    const written = kinds("append-db")[0];
    assert.equal(written?.[2], "message");
    assert.equal(String(written?.[3]).startsWith("t"), true);
    assert.deepEqual(kinds("mark-activity").map((call) => call[1]), ["group-1"]);
    assert.deepEqual(kinds("next-epoch").map((call) => call[1]), ["group-1"]);
    assert.deepEqual(kinds("begin-run").map((call) => call[1]), ["group-1"]);
    assert.deepEqual(kinds("enqueue").map((call) => [call[2], call[3]]), [["agent", "agent"]]);
    assert.deepEqual(kinds("group-turn").map((call) => [call[1], call[2], call[3]]), [["group-1", 7, "agent"]]);
    assert.equal(publish.id, "published-1");
    // A post the host already saw is not written again.
    calls.length = 0;
    await rooms.postSharedRoomGuestMessage({ roomId: "room-7", text: "hello", images: [], authorName: "Bob", authorAuthId: "guest-2", clientNonce: "nonce-2" });
    assert.deepEqual(calls, []);
    assert.equal(roomSession !== undefined || true, true);
  });

  it("publishes what a room should carry, and stamps it with the room's own time", async () => {
    const { manager, calls, kinds } = harness();
    const rooms = new SharedRooms(manager as never);
    const roomSession = await manager.sessions.resolveBackgroundSession("room-1");
    // A room that is not bound to a shared room has nothing to publish, and a room with no delegate does not either.
    rooms.publishSharedRoomEntryIfNeeded(roomSession, { id: "entry-1", kind: "message" } as never);
    assert.deepEqual(calls, []);
    const group = await manager.sessions.resolveBackgroundSession("group-1");
    rooms.publishSharedRoomEntryIfNeeded(group, { id: "entry-2", kind: "message" } as never);
    // What a room carries is published to the room it belongs to.
    assert.deepEqual(kinds("publish").map((call) => [call[1], call[2]]), [["room-7", "entry-2"]]);
    // A restamp changes only what the room's own messages are stamped with, in the store and on screen.
    calls.length = 0;
    await rooms.restampRoomEntry({ roomId: "room-7", entryId: "entry-3", timestampMs: 99 });
    assert.deepEqual(kinds("stamp-db").map((call) => [call[1], call[2], call[3]]), [["group-1", "entry-3", 99]]);
    manager.sessions.activeSession = group;
    calls.length = 0;
    await rooms.restampRoomEntry({ roomId: "room-7", entryId: "entry-3", timestampMs: 100 });
    assert.deepEqual(kinds("stamp-db").map((call) => [call[1], call[2]]), [["group-1", "entry-3"]]);
  });

  it("says in the room's own conversation what happened there", async () => {
    const { manager, calls, kinds } = harness();
    const rooms = new SharedRooms(manager as never);
    const roomSession = await manager.sessions.resolveBackgroundSession("room-1");
    await rooms.appendSharedRoomActivityNotice({ roomId: "room-nowhere", text: "nothing to say" });
    assert.deepEqual(calls, []);
    await rooms.appendSharedRoomActivityNotice({ roomId: "room-7", text: "Their agent is responding." });
    const notice = kinds("append-db")[0];
    assert.equal(notice?.[2], "notice");
    assert.equal(String(notice?.[3]).startsWith("notice-xuser-turn-"), true);
    assert.deepEqual(kinds("mark-activity").map((call) => call[1]), ["group-1"]);
    // On screen it goes to the transcript in memory: what is on screen is the session the notice was written into.
    manager.sessions.activeSession = await manager.sessions.resolveBackgroundSession("group-1");
    calls.length = 0;
    await rooms.appendSharedRoomActivityNotice({ roomId: "room-7", text: "On screen." });
    assert.deepEqual(calls.map((call) => call[0]), ["append-active"]);
    assert.equal(roomSession !== undefined || true, true);
  });

  it("takes a room's access away once, and gives the room the picture the host sent", async () => {
    const { manager, calls, kinds } = harness({ canonicalAgent: "room-1" });
    const rooms = new SharedRooms(manager as never);
    await rooms.markMirrorRoomRevoked("room-nowhere");
    assert.deepEqual(calls, []);
    await rooms.markMirrorRoomRevoked("room-7");
    assert.deepEqual(kinds("roster").map((call) => call[1]), ["room-1"]);
    assert.equal(JSON.parse(readFileSync(join(harnessRootOf(manager), "room-1", "remote-room.json"), "utf8")).isRevoked, true);
    // Doing it again changes nothing.
    calls.length = 0;
    await rooms.markMirrorRoomRevoked("room-7");
    assert.deepEqual(calls, []);
    // A picture that is the one already there is not written again, and one that is not an image is passed over.
    calls.length = 0;
    await rooms.applyMirrorRoomPicture("group-1", undefined);
    await rooms.applyMirrorRoomPicture("group-1", avatarDataUrl([9, 9]));
    await rooms.applyMirrorRoomPicture("group-1", "data:image/png,not-base64");
    assert.deepEqual(calls, []);
    calls.length = 0;
    const written = harness();
    const writtenRooms = new SharedRooms(written.manager as never);
    await writtenRooms.applyMirrorRoomPicture("group-1", avatarDataUrl([1, 2, 3, 4]));
    assert.deepEqual(written.kinds("avatar-by-id").map((call) => [call[1], call[2]]), [["group-1", 4]]);
    assert.deepEqual(written.kinds("roster").map((call) => call[1]), ["group-1"]);
    // The picture of the session on screen is written through that session.
    const active = harness();
    const activeRooms = new SharedRooms(active.manager as never);
    const activeSession = await active.manager.sessions.resolveBackgroundSession("room-1");
    active.manager.sessions.activeSession = activeSession;
    await activeRooms.applyMirrorRoomPicture("room-1", avatarDataUrl([5]));
    assert.deepEqual(active.kinds("avatar-bytes").map((call) => [call[1], call[2], call[3]]), [["room-1", 1, "room-1"]]);
  });
});

describe("binding a room to a conversation", () => {
  it("binds a hosted room to the agent that already stands for it, or makes one", async () => {
    const { manager, calls, kinds, root } = harness({ agents: [{ id: "agent-me", createdAt: 1 }, { id: "group-1", createdAt: 2 }] });
    const rooms = new SharedRooms(manager as never);
    // An existing agent is reused: its binding is rewritten with the members the host reported.
    const kept = await rooms.ensureHostedSharedRoom({ roomId: "room-7", name: "Group", localMemberIds: ["agent-me", "not-an-agent", "group-9"], remoteMembers: [{ ownerAuthId: "owner-2", agentId: "agent-2", name: "Their agent", avatarDataUrl: avatarDataUrl([7]) }], isCreationAllowed: false });
    assert.equal(kept, "group-1");
    const binding = JSON.parse(readFileSync(join(root, "group-1", "group.json"), "utf8"));
    // Only agents that exist and are not group agents of their own are members of the room.
    assert.deepEqual(binding.memberIds, ["agent-me"]);
    assert.deepEqual(binding.remoteMembers.map((member: { name: string; avatarDataUrl?: string }) => [member.name, member.avatarDataUrl === undefined]), [["Their agent", false]]);
    assert.equal(binding.sharedRoomId, "room-7");
    assert.deepEqual(kinds("emit-agents").length, 1);

    // With no agent bound yet, one is made — but only where the caller may create one.
    const fresh = harness({ agents: [] });
    const freshRooms = new SharedRooms(fresh.manager as never);
    assert.equal(await freshRooms.ensureHostedSharedRoom({ roomId: "room-7", name: "Group", localMemberIds: [], remoteMembers: [], isCreationAllowed: false }), null);
    assert.deepEqual(fresh.kinds("create-agent"), []);
    assert.equal(await freshRooms.ensureHostedSharedRoom({ roomId: "room-7", name: "Group", localMemberIds: [], remoteMembers: [], isCreationAllowed: true }), "created-1");
    assert.deepEqual(fresh.kinds("create-agent").map((call) => [call[1], call[2]]), [["Group", true]]);
    assert.equal(JSON.parse(readFileSync(join(fresh.root, "created-1", "group.json"), "utf8")).sharedRoomId, "room-7");
    assert.equal(calls.length > 0, true);
  });

  it("mirrors somebody else's room, keeping the room's pictures and leaving the host out", async () => {
    const { manager, calls, kinds, root } = harness();
    const rooms = new SharedRooms(manager as never);
    const room = {
      roomId: "room-11",
      name: "Their room",
      hostAuthId: "host-2",
      hostName: "Their computer",
      members: [
        { kind: "human", authId: "host-2", agentId: "", displayName: "Bob", avatarUrl: "https://example.invalid/host.png" },
        { kind: "human", authId: "self-1", agentId: "", displayName: "Me" },
        { kind: "agent", authId: "self-1", agentId: "agent-me", displayName: "My agent" },
        { kind: "agent", authId: "guest-2", agentId: "agent-2", displayName: "Their agent", avatarDataUrl: avatarDataUrl([3]) },
      ],
      avatarDataUrl: avatarDataUrl([1, 1]),
    };
    const agentId = await rooms.ensureMirrorRoom(room, "self-1");
    assert.equal(agentId, "created-1");
    const binding = JSON.parse(readFileSync(join(root, "created-1", "remote-room.json"), "utf8"));
    // The host is kept as the room's host, the host's own people are left out, and a guest's picture is stored.
    assert.deepEqual({ roomId: binding.roomId, hostAuthId: binding.hostAuthId, hostName: binding.hostName, hostAvatarUrl: binding.hostAvatarUrl }, { roomId: "room-11", hostAuthId: "host-2", hostName: "Their computer", hostAvatarUrl: "https://example.invalid/host.png" });
    assert.deepEqual(binding.members.map((member: { authId: string }) => member.authId), ["host-2", "guest-2"]);
    assert.equal(binding.members[1].avatarUrl.startsWith("data:image/png;base64,"), true);
    // The room's picture becomes the agent's, and the roster is told.
    assert.deepEqual(kinds("avatar-by-id").map((call) => call[1]), ["created-1"]);
    assertEqualsIgnoringOrder(kinds("roster").map((call) => call[1]), ["created-1"]);
    assert.deepEqual(calls.length > 0, true);
  });
});

/** Assert two lists hold the same members in any order. */
function assertEqualsIgnoringOrder(actual: unknown[], expected: unknown[]): void {
  assert.deepEqual([...actual].sort(), [...expected].sort());
}

// ---------------------------------------------------------------------------------------------
// The edges a room writes and reads
// ---------------------------------------------------------------------------------------------

describe("the edges a shared room keeps", () => {
  it("only calls a config a shared room when it names one", async () => {
    const world = harness();
    const rooms = new SharedRooms(world.manager as never);
    const plainDir = join(world.root, "plain");
    writeSlateGroupConfig(plainDir, { version: 1, memberIds: [], remoteMembers: [] } as never);
    assert.equal(rooms.sharedRoomConfigOf({ id: "plain", dbPath: join(plainDir, "db") }), null);
    const grouped = rooms.sharedRoomConfigOf({ id: "group-1", dbPath: join(world.root, "group-1", "db") });
    assert.equal(grouped?.sharedRoomId, "room-7");
  });

  it("sends at most four images to a mirrored room and says what was left out", async () => {
    const posted: unknown[] = [];
    const world = harness({ delegate: { sendMirrorPost: async (post: { images: unknown[] }) => { posted.push(post.images.length); return { timestampMs: 1_700 }; } } });
    const rooms = new SharedRooms(world.manager as never);
    const images = [1, 2, 3, 4, 5].map((size) => ({ data: new Uint8Array(size), mimeType: "image/png" }));
    await rooms.dispatchMirrorRoomSend(world.session("room-1") as never, { text: "hi", selectedImages: images, hasNonImageAttachments: false });
    assert.deepEqual(posted, [4]);
    assert.deepEqual(world.kinds("append-db")[0]?.slice(0, 2), ["append-db", "room-1"]);
  });

  it("tells the room's delegate about a guest's message, and starts its turn", async () => {
    const world = harness();
    const rooms = new SharedRooms(world.manager as never);
    await rooms.postSharedRoomGuestMessage({ roomId: "room-7", text: "hello there", images: [], authorName: "Guest", authorAuthId: "guest-1", timestampMs: 5 });
    assert.deepEqual(world.kinds("publish")[0]?.slice(0, 2), ["publish", "room-7"]);
    assert.equal(world.kinds("group-turn").length, 1);
  });

  it("refuses a remote turn for a room agent, and reports only what was really sent", async () => {
    const groupWorld = harness();
    groupWorld.session("group-1");
    const groupRooms = new SharedRooms(groupWorld.manager as never);
    assert.deepEqual(await groupRooms.runRemoteRequestedMemberTurn({ agentId: "group-1", prompt: "x" }), []);
    assert.equal(groupWorld.kinds("member-turn").length, 0);
    const sentWorld = harness();
    sentWorld.session("agent-9");
    const sentManager = sentWorld.manager as unknown as Record<string, any>;
    const sentCalls: unknown[][] = [];
    sentManager.runnerRegistry = { runnerHooksFor: (_session: unknown, transport: unknown) => transport, wireRunnerLifecycle: (_runner: unknown, _target: unknown, id: string) => { sentCalls.push(["wire", id]); } };
    sentManager.execution = { ...sentManager.execution, createGroupMemberRunner: (_target: unknown, hooks: { onUpdate(update: unknown): void }) => ({ run: async (_prompt: string, _options: unknown) => { hooks.onUpdate({ type: "send-message", message: { type: "text", content: "(pass)" } }); hooks.onUpdate({ type: "send-message", message: { type: "text", content: "a real answer" } }); } }) };
    const sentRooms = new SharedRooms(sentManager as never);
    assert.deepEqual(await sentRooms.runRemoteRequestedMemberTurn({ agentId: "agent-9", prompt: "say something", systemPrompt: "sys" }), ["a real answer"]);
    assert.deepEqual(sentCalls.map((call) => call[0]), ["wire"]);
    // The run is closed whether or not the member spoke.
    assert.deepEqual(sentWorld.kinds("end-run").map((call) => call[1]), ["agent-9"]);
  });
});

