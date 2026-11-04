import assert from "node:assert/strict";
import { setImmediate as flush } from "node:timers/promises";
import { describe, it } from "node:test";

import {
  REMOTE_MEMBER_UNREACHABLE_BACKOFF_MS,
  REMOTE_TURN_BUDGET_MAX,
  REMOTE_TURN_BUDGET_WINDOW_MS,
  SlateXuserRemoteTurns,
  type RemoteTurnsHost,
} from "../../source/host/rooms/xuser-remote-turns.ts";

interface TestRoom {
  roomId: string;
  name: string;
  hostName: string;
  hostAuthId: string;
  members: Array<{ kind: string; authId: string; agentId?: string }>;
}

interface RunRequestEvent {
  roomId: string;
  turnNonce: string;
  agentId: string;
  hostAuthId: string;
  [key: string]: unknown;
}

type DeadlineRunner = <T>(work: (signal: AbortSignal) => Promise<T>) => Promise<T>;

interface HarnessOptions {
  enabled?: boolean;
  selfAuthId?: string | null;
  profile?: { name: string; description: string } | null;
  deadline?: DeadlineRunner;
  onDrain?: (service: SlateXuserRemoteTurns, payload: Record<string, unknown> | undefined) => void;
  send?: (payload: Record<string, unknown>) => Promise<unknown>;
  runMemberTurn?: (args: { agentId: string; systemPrompt: string; prompt: string }) => Promise<string[]>;
}

function harness(options: HarnessOptions = {}) {
  let now = 1_000;
  let service: SlateXuserRemoteTurns;
  const room: TestRoom = {
    roomId: "room-1",
    name: "Design room",
    hostName: "Room host",
    hostAuthId: "host-1",
    members: [
      { kind: "human", authId: "self-1" },
      { kind: "agent", authId: "self-1", agentId: "agent-1" },
    ],
  };
  const state = {
    marked: [] as string[],
    seenNonces: new Set<string>(),
    sent: [] as Record<string, unknown>[],
    drains: 0,
    profileReads: 0,
    notices: [] as Array<{ roomId: string; text: string }>,
    runRequests: [] as Array<{ agentId: string; systemPrompt: string; prompt: string }>,
    removedAgents: [] as string[],
    reconciled: 0,
  };
  const relay = {
    async send(payload: unknown) {
      const request = payload as Record<string, unknown>;
      state.sent.push(request);
      return options.send?.(request);
    },
    requestDrain() {
      state.drains += 1;
      options.onDrain?.(service, state.sent.at(-1));
    },
    async removeDeletedAgent(agentId: string) {
      state.removedAgents.push(agentId);
    },
  };
  const manager = {
    async getAgentDisplayProfile() {
      state.profileReads += 1;
      return options.profile === undefined ? null : options.profile;
    },
    async appendSharedRoomActivityNotice(args: { roomId: string; text: string }) {
      state.notices.push(args);
    },
    async runRemoteRequestedMemberTurn(args: { agentId: string; systemPrompt: string; prompt: string }) {
      state.runRequests.push(args);
      return options.runMemberTurn?.(args) ?? ["first answer", "second answer", "unused third"];
    },
  };
  const deadline: DeadlineRunner = options.deadline ?? ((work) => work(new AbortController().signal));
  const host = {
    relay,
    manager,
    clock: { now: () => now },
    remoteTurnDeadline: { name: "test remote deadline", run: deadline },
    isEnabled: () => options.enabled ?? true,
    getSelfAuthId: () => options.selfAuthId === undefined ? "self-1" : options.selfAuthId,
    getRooms: () => [room],
    turnDedupe: {
      markSeenIfNew(nonce: string) {
        state.marked.push(nonce);
        if (state.seenNonces.has(nonce)) return false;
        state.seenNonces.add(nonce);
        return true;
      },
    },
    async reconcileShareState() {
      state.reconciled += 1;
    },
  } as unknown as RemoteTurnsHost;
  service = new SlateXuserRemoteTurns(host);
  return {
    service,
    state,
    room,
    setNow(value: number) { now = value; },
  };
}

const request = (turnNonce: string, overrides: Partial<RunRequestEvent> = {}): RunRequestEvent => ({
  roomId: "room-1",
  turnNonce,
  agentId: "agent-1",
  hostAuthId: "host-1",
  ...overrides,
});

const remoteTurnArgs = (memberId = "slate-remote:owner-1/agent-2") => ({
  member: { id: memberId },
  sharedRoomId: "room-1",
  group: { name: "Build room", description: "Release planning" },
  peers: [{ name: "Peer A", description: "writer" }],
  newMessages: [
    { speaker: { kind: "user" as const, name: "Alice" }, content: "Review this build" },
    { speaker: { kind: "member" as const, id: memberId, name: "Agent" }, content: "I am ready" },
  ],
});

describe("asking a remote room member for its turn", () => {
  it("sends a typed request, drains the relay, filters its answer, and accepts only two messages", async () => {
    const world = harness({
      onDrain: (service, sent) => service.handleTurnResult({
        turnNonce: sent?.turnNonce,
        messages: ["first", 17, "second", "extra"],
      }),
    });
    const result = await world.service.runRemoteMemberTurn(remoteTurnArgs());
    const sent = world.state.sent[0];
    assert.deepEqual(result, ["first", "second"]);
    assert.equal(sent?.kind, "turn-request");
    assert.equal(sent?.roomId, "room-1");
    assert.equal(sent?.ownerAuthId, "owner-1");
    assert.equal(sent?.agentId, "agent-2");
    assert.deepEqual(sent?.peers, [{ name: "Peer A", description: "writer" }]);
    assert.deepEqual(sent?.newMessages, [
      { speakerKind: "human", speakerName: "Alice", text: "Review this build" },
      { speakerKind: "agent", speakerName: "Agent", isSelf: true, text: "I am ready" },
    ]);
    assert.equal(typeof sent?.turnNonce, "string");
    assert.equal(world.state.drains, 1);
    assert.equal(world.service.handleTurnResult({ turnNonce: sent?.turnNonce, messages: ["late"] }), true);
  });

  it("does nothing while disabled or for an id that is not a remote member", async () => {
    const answerUnexpectedRequest = (service: SlateXuserRemoteTurns, sent: Record<string, unknown> | undefined) =>
      service.handleTurnResult({ turnNonce: sent?.turnNonce, messages: ["unexpected"] });
    const disabled = harness({ enabled: false, onDrain: answerUnexpectedRequest });
    assert.deepEqual(await disabled.service.runRemoteMemberTurn(remoteTurnArgs()), []);
    const local = harness({ onDrain: answerUnexpectedRequest });
    assert.deepEqual(await local.service.runRemoteMemberTurn(remoteTurnArgs("agent-local")), []);
    const malformed = harness({ onDrain: answerUnexpectedRequest });
    assert.deepEqual(await malformed.service.runRemoteMemberTurn(remoteTurnArgs("slate-remote:only-owner")), []);
    assert.deepEqual([disabled.state.sent.length, local.state.sent.length, malformed.state.sent.length], [0, 0, 0]);
  });

  it("backs off a timed-out remote member until the exact retry boundary, then clears after a response", async () => {
    let forceTimeout = true;
    const world = harness({
      deadline: async <T>(_work: (signal: AbortSignal) => Promise<T>): Promise<T> => {
        if (forceTimeout) throw new Error("deadline");
        return _work(new AbortController().signal);
      },
      onDrain: (service, sent) => service.handleTurnResult({ turnNonce: sent?.turnNonce, messages: ["reply"] }),
    });
    assert.deepEqual(await world.service.runRemoteMemberTurn(remoteTurnArgs()), []);
    assert.equal(world.state.drains, 1);
    world.setNow(1_000 + REMOTE_MEMBER_UNREACHABLE_BACKOFF_MS - 1);
    assert.deepEqual(await world.service.runRemoteMemberTurn(remoteTurnArgs()), []);
    assert.equal(world.state.sent.length, 1);

    forceTimeout = false;
    world.setNow(1_000 + REMOTE_MEMBER_UNREACHABLE_BACKOFF_MS);
    assert.deepEqual(await world.service.runRemoteMemberTurn(remoteTurnArgs()), ["reply"]);
    world.setNow(1_000 + REMOTE_MEMBER_UNREACHABLE_BACKOFF_MS - 1);
    assert.deepEqual(await world.service.runRemoteMemberTurn(remoteTurnArgs()), ["reply"]);
    assert.equal(world.state.sent.length, 3);
    assert.equal(REMOTE_MEMBER_UNREACHABLE_BACKOFF_MS, 600_000);
  });

  it("does not drain after the outgoing request itself fails", async () => {
    const world = harness({ send: async () => { throw new Error("relay down"); } });
    assert.deepEqual(await world.service.runRemoteMemberTurn(remoteTurnArgs()), []);
    assert.equal(world.state.sent.length, 1);
    assert.equal(world.state.drains, 0);
  });

  it("completes pending requests with an empty answer when stopped", async () => {
    let notifyDrain: (() => void) | undefined;
    const drained = new Promise<void>((resolve) => { notifyDrain = resolve; });
    const world = harness({ onDrain: () => notifyDrain?.() });
    const pending = world.service.runRemoteMemberTurn(remoteTurnArgs());
    await drained;
    world.service.stop();
    assert.deepEqual(await pending, []);
    assert.equal(world.state.drains, 1);
  });
});

describe("receiving a remote member's requested turn", () => {
  it("validates host, room, human membership, and agent membership before deduping", async () => {
    const world = harness();
    assert.equal(world.service.handleTurnRequest({ turnNonce: "missing" }), true);
    assert.equal(world.service.handleTurnRequest(request("wrong-host", { hostAuthId: "not-host" })), true);
    world.room.members = [{ kind: "agent", authId: "self-1", agentId: "agent-1" }];
    assert.equal(world.service.handleTurnRequest(request("no-human")), true);
    world.room.members = [{ kind: "human", authId: "self-1" }, { kind: "agent", authId: "self-1", agentId: "different-agent" }];
    assert.equal(world.service.handleTurnRequest(request("no-agent")), true);
    world.room.members = [
      { kind: "human", authId: "self-1" },
      { kind: "agent", authId: "self-1", agentId: "agent-1" },
    ];
    assert.equal(world.service.handleTurnRequest(request("accepted")), true);
    assert.equal(world.service.handleTurnRequest(request("accepted")), true);
    assert.deepEqual(world.state.marked, ["accepted", "accepted"]);
    assert.equal(world.state.profileReads, 1);
    await flush();
    assert.deepEqual(world.state.removedAgents, ["agent-1"]);
    assert.equal(world.state.reconciled, 1);
  });

  it("limits accepted turns per room, host and agent over a rolling window", () => {
    const world = harness();
    for (let index = 0; index < REMOTE_TURN_BUDGET_MAX; index += 1) {
      world.service.handleTurnRequest(request(`nonce-${index}`));
    }
    assert.equal(world.state.profileReads, REMOTE_TURN_BUDGET_MAX);
    world.service.handleTurnRequest(request("over-limit"));
    assert.equal(world.state.profileReads, REMOTE_TURN_BUDGET_MAX);
    world.setNow(1_000 + REMOTE_TURN_BUDGET_WINDOW_MS);
    world.service.handleTurnRequest(request("at-window-boundary"));
    assert.equal(world.state.profileReads, REMOTE_TURN_BUDGET_MAX + 1);
    for (let index = 0; index < REMOTE_TURN_BUDGET_MAX - 1; index += 1) {
      world.service.handleTurnRequest(request(`refill-${index}`));
    }
    assert.equal(world.state.profileReads, REMOTE_TURN_BUDGET_MAX * 2);
    world.service.handleTurnRequest(request("full-again"));
    assert.equal(world.state.profileReads, REMOTE_TURN_BUDGET_MAX * 2);
    world.service.stop();
    world.service.handleTurnRequest(request("after-stop-clears-budget"));
    assert.equal(world.state.profileReads, REMOTE_TURN_BUDGET_MAX * 2 + 1);
  });

  it("normalizes peers and incoming messages, announces the turn, and relays at most two replies", async () => {
    const world = harness({
      profile: { name: "Remote agent", description: "Builds software" },
      runMemberTurn: async () => ["one", "two", "three"],
    });
    await world.service.runRequestedTurn({
      roomId: "room-1",
      turnNonce: "nonce-1",
      agentId: "agent-1",
      groupName: "Release room",
      groupDescription: "Plan the launch",
      peers: ["not a record", { name: "  Bea\n  ", description: 5 }, { name: 3, description: "reviewer" }],
      newMessages: [
        { speakerKind: "human", speakerName: "Alice", text: "Review the release" },
        { speakerKind: "agent", speakerName: "Remote member", isSelf: true, text: "Ready" },
        { speakerKind: "human", speakerName: "bad", text: 9 },
      ],
    }, world.room as never);

    assert.deepEqual(world.state.notices, [{ roomId: "room-1", text: "Remote agent is responding in Design room at the request of Room host." }]);
    assert.equal(world.state.runRequests.length, 1);
    assert.equal(world.state.runRequests[0]?.agentId, "agent-1");
    assert.match(world.state.runRequests[0]?.systemPrompt ?? "", /what you send here leaves your user's device/);
    assert.match(world.state.runRequests[0]?.prompt ?? "", /Review the release/);
    assert.match(world.state.runRequests[0]?.prompt ?? "", /Bea/);
    assert.deepEqual(world.state.sent, [{ kind: "turn-result", roomId: "room-1", turnNonce: "nonce-1", agentId: "agent-1", messages: ["one", "two"] }]);
  });

  it("removes a deleted agent and replies empty when profile lookup fails", async () => {
    const deleted = harness({ profile: null });
    await deleted.service.runRequestedTurn({ roomId: "room-1", turnNonce: "deleted", agentId: "gone" }, deleted.room as never);
    assert.deepEqual(deleted.state.removedAgents, ["gone"]);
    assert.equal(deleted.state.reconciled, 1);
    assert.deepEqual(deleted.state.sent, []);

    const failed = harness({
      profile: { name: "Agent", description: "" },
      runMemberTurn: async () => { throw new Error("runner failed"); },
    });
    failed.state.sent.length = 0;
    await failed.service.runRequestedTurn({ roomId: "room-1", turnNonce: "failed", agentId: "agent-1" }, failed.room as never);
    assert.deepEqual(failed.state.sent, [{ kind: "turn-result", roomId: "room-1", turnNonce: "failed", agentId: "agent-1", messages: [] }]);
  });
});
