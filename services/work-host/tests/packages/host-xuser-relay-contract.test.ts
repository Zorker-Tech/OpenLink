import assert from "node:assert/strict";
import { setImmediate as flush } from "node:timers/promises";
import { describe, it } from "node:test";

import {
  describeRelayError,
  SlateXuserRelayClient,
  SlateXuserRelayHttpError,
  XUSER_RELAY_ERROR_BACKOFF_MS,
  XUSER_RELAY_POLL_INTERVAL_MS,
  type XuserRelayClientDependencies,
} from "../../source/host/rooms/xuser-relay.ts";

interface FakeResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}

interface FetchCall {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

interface RelayWorldOptions {
  readonly responses?: unknown[];
  readonly onEvent?: (event: Record<string, unknown>) => Promise<boolean>;
  readonly fetchImpl?: typeof fetch;
  readonly connected?: () => boolean;
  readonly safetyPoll?: () => boolean;
  readonly onPollError?: (error: unknown) => void;
}

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; },
  } as Response;
}

function relayWorld(options: RelayWorldOptions = {}) {
  let now = 100;
  let pollTick: (() => Promise<void>) | undefined;
  let starts = 0;
  let stops = 0;
  const pendingResponses = [...(options.responses ?? [])];
  const fetchCalls: FetchCall[] = [];
  const tokenLookups: string[] = [];
  const errors: unknown[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    fetchCalls.push({ url: String(input), init });
    if (options.fetchImpl !== undefined) return options.fetchImpl(input, init);
    return response(pendingResponses.shift() ?? { events: [] });
  };
  const deps: XuserRelayClientDependencies = {
    getBackendUrl: () => "https://backend.example/root/",
    getAccessToken: async ({ backendUrl }) => {
      tokenLookups.push(backendUrl);
      return "access-token";
    },
    onEvent: options.onEvent ?? (async () => true),
    pollPolicy: {
      name: "relay-test",
      start(callback) {
        starts += 1;
        pollTick = callback;
        return { dispose: () => { stops += 1; } };
      },
    },
    clock: { now: () => now },
    fetchImpl,
    ...(options.connected === undefined ? {} : { isNotifyConnected: options.connected }),
    ...(options.safetyPoll === undefined ? {} : { isNotifySafetyPollEnabled: options.safetyPoll }),
    onPollError: (error) => {
      errors.push(error);
      options.onPollError?.(error);
    },
  };
  const client = new SlateXuserRelayClient(deps);
  return {
    client,
    fetchCalls,
    tokenLookups,
    errors,
    get starts() { return starts; },
    get stops() { return stops; },
    get pollTick() { return pollTick; },
    setNow(value: number) { now = value; },
  };
}

function bodyOf(call: FetchCall | undefined): unknown {
  return call?.init?.body == null ? undefined : JSON.parse(String(call.init.body));
}

describe("polling the room relay", () => {
  it("dispatches each new event once and carries acknowledgements into the next poll", async () => {
    const delivered: string[] = [];
    const world = relayWorld({
      connected: () => true,
      safetyPoll: () => false,
      responses: [
        { events: [null, { id: 3, kind: "wrong-id" }, { id: "missing-kind" }, { id: "event-1", kind: "post" }, { id: "event-1", kind: "duplicate" }, { id: "event-2", kind: "join" }, { id: "event-3", kind: "leave" }, { id: "event-4", kind: "turn" }] },
        { events: [{ id: "event-1", kind: "redelivered" }] },
      ],
      onEvent: async (event) => {
        const id = String(event.id);
        delivered.push(id);
        if (id === "event-2") return false;
        if (id === "event-3") throw new Error("temporary handler failure");
        return true;
      },
    });
    await world.client.tick();
    assert.deepEqual(delivered, ["event-1", "event-2", "event-3", "event-4"]);
    assert.deepEqual(bodyOf(world.fetchCalls[0]), { ackIds: [] });

    await world.client.tick();
    assert.deepEqual(bodyOf(world.fetchCalls[1]), { ackIds: ["event-1", "event-1", "event-4"] });
    assert.deepEqual(delivered, ["event-1", "event-2", "event-3", "event-4"]);
    assert.deepEqual(bodyOf(world.fetchCalls[2]), undefined);
  });

  it("polls on schedule, starts once, drains recorded notifications after the floor, and stops idempotently", async () => {
    const world = relayWorld({ connected: () => true, safetyPoll: () => false });
    world.client.start();
    world.client.start();
    assert.equal(world.starts, 1);
    await world.pollTick?.();
    assert.equal(world.fetchCalls.length, 1, "the first poll runs without waiting for a notify");

    await world.pollTick?.();
    assert.equal(world.fetchCalls.length, 1, "a connected relay waits when no work is owed");
    world.client.requestDrain();
    await flush();
    assert.equal(world.fetchCalls.length, 1, "a notify is held until the drain floor passes");
    world.setNow(100 + 4_000);
    world.client.requestDrain();
    await flush();
    assert.equal(world.fetchCalls.length, 2);

    world.client.stop();
    world.client.stop();
    assert.equal(world.stops, 1);
    world.client.requestDrain();
    assert.equal(world.fetchCalls.length, 2);
    world.client.start();
    await world.pollTick?.();
    assert.equal(world.fetchCalls.length, 3, "a restarted relay drains immediately");
  });

  it("backs off after a poll error, reports it once, and resumes at the boundary", async () => {
    let failed = false;
    const world = relayWorld({
      connected: () => false,
      fetchImpl: async () => {
        if (!failed) {
          failed = true;
          throw new Error("network down");
        }
        return response({ events: [] });
      },
    });
    await world.client.tick();
    assert.equal(world.errors.length, 1);
    assert.match(String(world.errors[0]), /network down/);
    assert.equal(world.fetchCalls.length, 1);
    await world.client.tick();
    assert.equal(world.fetchCalls.length, 1);
    world.setNow(100 + XUSER_RELAY_ERROR_BACKOFF_MS - 1);
    await world.client.tick();
    assert.equal(world.fetchCalls.length, 1);
    world.setNow(100 + XUSER_RELAY_ERROR_BACKOFF_MS);
    await world.client.tick();
    assert.equal(world.fetchCalls.length, 2);
    assert.equal(XUSER_RELAY_ERROR_BACKOFF_MS, 30_000);
    assert.equal(XUSER_RELAY_POLL_INTERVAL_MS, 4_000);
  });

  it("does not overlap ticks while a fetch is still in flight", async () => {
    let finishFetch: ((value: Response) => void) | undefined;
    const world = relayWorld({
      fetchImpl: (async () => {
        return await new Promise<Response>((resolve) => { finishFetch = resolve; });
      }) as typeof fetch,
    });
    const first = world.client.tick();
    await flush();
    await flush();
    assert.equal(world.fetchCalls.length, 1);
    await world.client.tick();
    assert.equal(world.fetchCalls.length, 1);
    finishFetch?.(response({ events: [] }));
    await first;
    assert.equal(world.fetchCalls.length, 1);
  });
});

describe("calling relay routes", () => {
  it("posts a JSON body with the host token and Slate client headers", async () => {
    const world = relayWorld({ responses: [{ accepted: true }] });
    assert.deepEqual(await world.client.call("/slate/xuser/poll", { ackIds: ["a"] }), { accepted: true });
    const call = world.fetchCalls[0]!;
    assert.equal(call.url, "https://backend.example/slate/xuser/poll");
    assert.equal(call.init?.method, "POST");
    assert.deepEqual(bodyOf(call), { ackIds: ["a"] });
    const headers = call.init?.headers as Record<string, string>;
    assert.equal(headers["content-type"], "application/json");
    assert.equal(headers.authorization, "Bearer access-token");
    assert.equal(typeof headers["x-slate-box-namespace"], "string");
    assert.deepEqual(world.tokenLookups, ["https://backend.example/root/"]);
  });

  it("turns a non-success response into a typed error with status and route", async () => {
    const world = relayWorld({ fetchImpl: (async () => response({}, 403)) as typeof fetch });
    await assert.rejects(
      () => world.client.call("/slate/share-rooms", {}),
      (error: unknown) => error instanceof SlateXuserRelayHttpError
        && error.status === 403
        && error.path === "/slate/share-rooms"
        && error.message === "slate sharing /slate/share-rooms returned 403",
    );
    assert.equal(describeRelayError(new SlateXuserRelayHttpError(403, "/route")), "Sharing isn't enabled for your account.");
    assert.equal(describeRelayError(new SlateXuserRelayHttpError(429, "/route")), "You're doing that too often. Try again in a minute.");
    assert.equal(describeRelayError(new Error("offline")), "Couldn't reach the sharing service. Check your connection and try again.");
  });

  it("projects create and invite responses, and catches their route failures", async () => {
    const world = relayWorld({ responses: [
      { shareUrl: "https://share/1", expiresAtMs: 10, room: { roomId: "room-1" } },
      { shareUrl: "https://share/2", expiresAtMs: 20, room: { roomId: "room-2" } },
      {},
    ] });
    assert.deepEqual(await world.client.createRoomFromAgent({ agentId: "agent-1" }), {
      status: "ok", shareUrl: "https://share/1", expiresAtMs: 10, roomId: "room-1",
    });
    assert.deepEqual(await world.client.createRoomInvite("room-2"), {
      status: "ok", shareUrl: "https://share/2", expiresAtMs: 20, roomId: "room-2",
    });
    assert.equal(new URL(world.fetchCalls[0]!.url).pathname, "/slate/share-rooms/from-agent");
    assert.equal(new URL(world.fetchCalls[1]!.url).pathname, "/slate/share-rooms/invite-links");
    assert.deepEqual(bodyOf(world.fetchCalls[0]), { agentId: "agent-1" });
    assert.deepEqual(bodyOf(world.fetchCalls[1]), { roomId: "room-2" });

    const failed = relayWorld({ fetchImpl: (async () => response({}, 429)) as typeof fetch });
    assert.deepEqual(await failed.client.createRoomInvite("room-2"), {
      status: "error", message: "You're doing that too often. Try again in a minute.",
    });
  });

  it("maps join statuses and supplies safe names for incomplete success responses", async () => {
    const world = relayWorld({ responses: [
      { status: "pending" },
      { status: "already-member", room: { name: "Existing", roomId: "room-1" } },
      { status: "already-member", room: null },
      { status: "invalid" },
      { status: "denied" },
      { status: "rate-limited" },
      { status: "unexpected" },
    ] });
    assert.deepEqual(await world.client.joinRoom("join-1"), { status: "pending", roomName: "the shared room" });
    assert.deepEqual(await world.client.joinRoom("join-2"), { status: "already-member", roomName: "Existing", roomId: "room-1" });
    assert.deepEqual(await world.client.joinRoom("join-3"), { status: "already-member", roomName: "the shared room" });
    assert.deepEqual(await world.client.joinRoom("join-4"), { status: "invalid" });
    assert.deepEqual(await world.client.joinRoom("join-5"), { status: "denied" });
    assert.deepEqual(await world.client.joinRoom("join-6"), { status: "rate-limited" });
    assert.deepEqual(await world.client.joinRoom("join-7"), { status: "error", message: "Unexpected response." });
  });

  it("uses the expected route and omission rules for room actions, and sanitizes send timestamps", async () => {
    const world = relayWorld({ responses: [{}, {}, {}, {}, {}, {}, {}, {}, { timestampMs: 5 }, { timestampMs: Infinity }] });
    assert.deepEqual(await world.client.createRoom({ name: "Room" }), {});
    await world.client.respondToJoinRequest({ requestId: "request-1" });
    await world.client.addOwnAgent({ agentId: "agent-1" });
    await world.client.setRoomPicture({ roomId: "room-1" });
    await world.client.removeOwnAgent({ roomId: "room-1", agentId: "agent-1" });
    await world.client.removeDeletedAgent("agent-gone");
    await world.client.leaveRoom("room-1");
    await world.client.leaveRoom("room-2", "target-auth");
    assert.deepEqual(await world.client.send({ roomId: "room-1" }), { timestampMs: 5 });
    assert.deepEqual(await world.client.send({ roomId: "room-1" }), {});
    assert.deepEqual(world.fetchCalls.map((call) => new URL(call.url).pathname), [
      "/slate/share-rooms",
      "/slate/share-rooms/join/respond",
      "/slate/share-rooms/agents/add",
      "/slate/share-rooms/picture",
      "/slate/share-rooms/agents/remove",
      "/slate/share-rooms/agents/remove-deleted",
      "/slate/share-rooms/leave",
      "/slate/share-rooms/leave",
      "/slate/xuser/send",
      "/slate/xuser/send",
    ]);
    assert.deepEqual(bodyOf(world.fetchCalls[6]), { roomId: "room-1" });
    assert.deepEqual(bodyOf(world.fetchCalls[7]), { roomId: "room-2", targetAuthId: "target-auth" });
  });
});
