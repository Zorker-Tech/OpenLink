import assert from "node:assert/strict";
import { setTimeout as wait } from "node:timers/promises";
import { test } from "node:test";

import { createCrossUserSharingApi } from "../../source/host/rooms/xuser-sharing-extension-api.ts";
import { createCrossUserSharingEnabledState, createCrossUserSharingLifecycle } from "../../source/host/rooms/xuser-sharing-extension-lifecycle.ts";
import { createCrossUserSharingService, resolveCrossUserSharingAttachment } from "../../source/host/rooms/xuser-sharing-extension-service.ts";
import { SHARING_DISABLED_MESSAGE } from "../../source/host/rooms/extension.ts";
import { EMPTY_SLATE_SHARING_STATE } from "../../source/shared/agents/sharing.ts";

function lifecycleWorld(options: { allowed?: boolean; reason?: string; startError?: Error } = {}) {
  const calls: Array<[string, unknown?]> = [];
  const bindings: unknown[] = [];
  const logs: string[] = [];
  const warnings: string[] = [];
  const listeners = new Set<(state: unknown) => void>();
  const published: unknown[] = [];
  const delegate = { publishRoomEntry: () => {} };
  const service = {
    buildManagerDelegate: () => { calls.push(["build-delegate"]); return delegate; },
    start: async () => { calls.push(["start"]); if (options.startError !== undefined) throw options.startError; },
    stop: () => { calls.push(["stop"]); },
    requestRelayDrain: () => { calls.push(["drain"]); },
  };
  const lifecycle = createCrossUserSharingLifecycle({
    service: service as never,
    enabledState: createCrossUserSharingEnabledState(),
    transcript: { setXuserDelegate: (value) => { bindings.push(value); } },
    host: { log: (message) => logs.push(message) },
    environment: { isAllowed: options.allowed ?? true, ...(options.reason === undefined ? {} : { reason: options.reason }) },
    listeners,
    warn: (message) => warnings.push(message),
  });
  listeners.add((state) => published.push(state));
  return { calls, bindings, logs, warnings, listeners, published, delegate, lifecycle };
}

test("the first off edge clears the transcript delegate and publishes the empty state once", () => {
  const world = lifecycleWorld();
  assert.equal(world.lifecycle.isEnabled, false);
  assert.equal(world.lifecycle.isStopped, false);
  world.lifecycle.requestRelayDrain();
  assert.deepEqual(world.calls, [["build-delegate"]]);
  world.lifecycle.applyGate(false);
  world.lifecycle.applyGate(false);
  assert.equal(world.lifecycle.isEnabled, false);
  assert.deepEqual(world.bindings, [null]);
  assert.deepEqual(world.calls, [["build-delegate"], ["stop"]]);
  assert.deepEqual(world.published, [EMPTY_SLATE_SHARING_STATE]);
});

test("the gate starts on state changes, publishes its delegate, and ignores repeated values", async () => {
  const world = lifecycleWorld();
  world.lifecycle.applyGate(true);
  world.lifecycle.applyGate(true);
  assert.equal(world.lifecycle.isEnabled, true);
  assert.deepEqual(world.bindings, [world.delegate]);
  assert.deepEqual(world.calls, [["build-delegate"], ["start"]]);
  world.lifecycle.requestRelayDrain();
  assert.deepEqual(world.calls.at(-1), ["drain"]);
  world.lifecycle.applyGate(false);
  world.lifecycle.applyGate(false);
  await wait(0);
  assert.equal(world.lifecycle.isEnabled, false);
  assert.deepEqual(world.bindings, [world.delegate, null]);
  assert.deepEqual(world.calls, [["build-delegate"], ["start"], ["drain"], ["stop"]]);
  assert.deepEqual(world.published, [EMPTY_SLATE_SHARING_STATE]);
});

test("the environment guard warns and forces an enabled request back to off", () => {
  const world = lifecycleWorld({ allowed: false, reason: "sharing blocked here" });
  world.lifecycle.applyGuardedGate(true);
  assert.equal(world.lifecycle.isEnabled, false);
  assert.deepEqual(world.warnings, ["[slate:sharing] sharing blocked here"]);
  assert.deepEqual(world.bindings, [null]);
  assert.deepEqual(world.calls, [["build-delegate"], ["stop"]]);
});

test("an allowed environment passes feature-gate changes through", () => {
  const world = lifecycleWorld({ allowed: true });
  world.lifecycle.applyGuardedGate(true);
  assert.equal(world.lifecycle.isEnabled, true);
  assert.deepEqual(world.warnings, []);
  assert.deepEqual(world.bindings, [world.delegate]);
  assert.deepEqual(world.calls, [["build-delegate"], ["start"]]);
});

test("a start failure is reported but does not rewrite the enabled gate", async () => {
  const world = lifecycleWorld({ startError: new Error("relay unavailable") });
  world.lifecycle.applyGate(true);
  await wait(0);
  assert.equal(world.lifecycle.isEnabled, true);
  assert.deepEqual(world.logs, ["[slate:sharing] failed to start: relay unavailable"]);
});

test("stopping the extension detaches sharing, clears listeners, and blocks later gate changes", () => {
  const world = lifecycleWorld();
  world.lifecycle.applyGate(true);
  world.lifecycle.stop();
  const callsAtStop = [...world.calls];
  assert.equal(callsAtStop.some(([name]) => name === "stop"), true);
  world.lifecycle.applyGate(false);
  assert.equal(world.lifecycle.isStopped, true);
  assert.equal(world.lifecycle.isEnabled, true);
  assert.equal(world.listeners.size, 0);
  assert.deepEqual(world.bindings, [world.delegate, null]);
  assert.deepEqual(world.calls, callsAtStop);
});

function apiWorld(enabled: boolean) {
  const calls: Array<[string, unknown[]]> = [];
  const listeners = new Set<(state: unknown) => void>();
  const service = {
    getState: async () => ({ rooms: ["room"] }),
    createRoomFromAgent: async (...args: unknown[]) => { calls.push(["createRoomFromAgent", args]); return { status: "created" }; },
    createRoomInvite: async (...args: unknown[]) => { calls.push(["createRoomInvite", args]); return { status: "invite" }; },
    joinRoom: async (...args: unknown[]) => { calls.push(["joinRoom", args]); return { status: "joined" }; },
    respondToJoinRequest: async (...args: unknown[]) => { calls.push(["respondToJoinRequest", args]); return { status: "answered" }; },
    createSharedRoom: async (...args: unknown[]) => { calls.push(["createSharedRoom", args]); return { status: "created-room" }; },
    addOwnAgent: async (...args: unknown[]) => { calls.push(["addOwnAgent", args]); return { status: "added" }; },
    removeOwnAgent: async (...args: unknown[]) => { calls.push(["removeOwnAgent", args]); return { status: "removed" }; },
    setRoomTyping: async (...args: unknown[]) => { calls.push(["setRoomTyping", args]); },
    leaveSharedRoom: async (...args: unknown[]) => { calls.push(["leaveSharedRoom", args]); return { status: "left" }; },
    noteAgentDeleted: async (...args: unknown[]) => { calls.push(["noteAgentDeleted", args]); },
    start: async () => { calls.push(["start", []]); },
    stop: () => { calls.push(["stop", []]); },
  };
  const api = createCrossUserSharingApi({ service: service as never, isEnabled: () => enabled, listeners });
  return { api, calls, listeners };
}

test("disabled sharing APIs return their stable fallback and avoid service actions", async () => {
  const world = apiWorld(false);
  assert.equal(SHARING_DISABLED_MESSAGE, "Sharing isn't enabled for your account.");
  assert.equal(world.api.isEnabled, false);
  assert.deepEqual(await world.api.getSharingState(), { rooms: ["room"] });
  assert.deepEqual(await world.api.createRoomFromAgent({ agentId: "a" }), { status: "error", message: SHARING_DISABLED_MESSAGE });
  assert.deepEqual(await world.api.createRoomInvite({ roomId: "r" }), { status: "error", message: SHARING_DISABLED_MESSAGE });
  assert.deepEqual(await world.api.joinSharedRoom({ link: "link" }), { status: "error", message: SHARING_DISABLED_MESSAGE });
  assert.deepEqual(await world.api.respondToRoomJoinRequest({ requestId: "q" }), EMPTY_SLATE_SHARING_STATE);
  assert.deepEqual(await world.api.createSharedRoom({ agents: [] }), { status: "error", message: SHARING_DISABLED_MESSAGE });
  assert.deepEqual(await world.api.addOwnAgentToSharedRoom({ agentId: "a" }), EMPTY_SLATE_SHARING_STATE);
  assert.deepEqual(await world.api.removeOwnAgentFromSharedRoom({ roomId: "r", agentId: "a" }), EMPTY_SLATE_SHARING_STATE);
  assert.equal(await world.api.setSharedRoomTyping({ roomId: "r", isTyping: true }), undefined);
  assert.deepEqual(await world.api.leaveSharedRoom({ roomId: "r" }), EMPTY_SLATE_SHARING_STATE);
  assert.equal(await world.api.noteAgentDeleted("a"), undefined);
  assert.deepEqual(world.calls, []);
});

test("enabled sharing APIs forward their arguments and preserve update subscriptions", async () => {
  const world = apiWorld(true);
  assert.equal(world.api.isEnabled, true);
  assert.deepEqual(await world.api.createRoomFromAgent({ agentId: "a" }), { status: "created" });
  assert.deepEqual(await world.api.createRoomInvite({ roomId: "r" }), { status: "invite" });
  assert.deepEqual(await world.api.joinSharedRoom({ link: "link" }), { status: "joined" });
  const join = { requestId: "q", approve: true };
  assert.deepEqual(await world.api.respondToRoomJoinRequest(join), { status: "answered" });
  const create = { agents: [{ agentId: "a" }], name: "Group" };
  assert.deepEqual(await world.api.createSharedRoom(create), { status: "created-room" });
  assert.deepEqual(await world.api.addOwnAgentToSharedRoom({ agentId: "a", name: "Ada" }), { status: "added" });
  assert.deepEqual(await world.api.removeOwnAgentFromSharedRoom({ roomId: "r", agentId: "a" }), { status: "removed" });
  await world.api.setSharedRoomTyping({ roomId: "r", isTyping: true });
  assert.deepEqual(await world.api.leaveSharedRoom({ roomId: "r", targetAuthId: "peer" }), { status: "left" });
  await world.api.noteAgentDeleted("a");
  assert.deepEqual(world.calls, [
    ["createRoomFromAgent", ["a"]],
    ["createRoomInvite", ["r"]],
    ["joinRoom", ["link"]],
    ["respondToJoinRequest", [join]],
    ["createSharedRoom", [create]],
    ["addOwnAgent", [{ agentId: "a", name: "Ada" }]],
    ["removeOwnAgent", ["r", "a"]],
    ["setRoomTyping", ["r", true]],
    ["leaveSharedRoom", ["r", "peer"]],
    ["noteAgentDeleted", ["a"]],
  ]);

  const states: unknown[] = [];
  const unsubscribe = world.api.subscribe((state) => states.push(state));
  for (const listener of world.listeners) listener({ rooms: ["next"] });
  assert.deepEqual(states, [{ rooms: ["next"] }]);
  unsubscribe();
  assert.equal(world.listeners.size, 0);
});

test("upgrade preparation always stops and recreation resumes only while enabled", async () => {
  const on = apiWorld(true);
  on.api.prepareForUpgrade();
  await on.api.resumeAfterRecreate();
  assert.deepEqual(on.calls, [["stop", []], ["start", []]]);

  const off = apiWorld(false);
  off.api.prepareForUpgrade();
  await off.api.resumeAfterRecreate();
  assert.deepEqual(off.calls, [["stop", []]]);
});

test("only uploaded images are accepted as shared room attachments", async () => {
  const image = { transport: "upload", isImage: true, bytes: new Uint8Array([1, 2]), mime: "image/png" };
  const source = {
    resolveChannelAttachment: async (url: string) => url === "missing"
      ? null
      : url === "link"
        ? { ...image, transport: "url" }
        : url === "text"
          ? { ...image, isImage: false }
          : image,
  };
  assert.equal(await resolveCrossUserSharingAttachment(source, "missing"), null);
  assert.equal(await resolveCrossUserSharingAttachment(source, "link"), null);
  assert.equal(await resolveCrossUserSharingAttachment(source, "text"), null);
  assert.deepEqual(await resolveCrossUserSharingAttachment(source, "upload"), { data: new Uint8Array([1, 2]), mimeType: "image/png" });
});

test("the extension service gives its publisher the same upload-and-image filter", async () => {
  const resolved: string[] = [];
  const service = createCrossUserSharingService({
    auth: { getAccessToken: async () => "token" },
    manager: {} as never,
    attachments: {
      resolveChannelAttachment: async (url) => {
        resolved.push(url);
        if (url === "image") return { transport: "upload", isImage: true, bytes: new Uint8Array([7]), mime: "image/webp" };
        if (url === "remote") return { transport: "url", isImage: true, bytes: new Uint8Array([8]), mime: "image/png" };
        return { transport: "upload", isImage: false, bytes: new Uint8Array([9]), mime: "text/plain" };
      },
    },
    notifyBus: { isConnected: () => false, isSafetyPollEnabled: () => false },
    isEnabled: () => true,
    emitSharing: () => {},
  });
  assert.deepEqual(await service.publisher.inlineImages([
    { url: "image", alt: "diagram" },
    { url: "remote" },
    { url: "text" },
  ]), [{ base64: "Bw==", mediaType: "image/webp", alt: "diagram" }]);
  assert.deepEqual(resolved, ["image", "remote", "text"]);
});
