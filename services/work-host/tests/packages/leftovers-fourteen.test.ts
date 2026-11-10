/**
 * The gateway's wire vocabulary, the coordinator's carrier and relay, the store's object probe and the
 * binary a conversation's state is stored in.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isLoopbackHost, parseCommandArgs, SLATE_GATEWAY_COMMANDS, SLATE_GATEWAY_SLIM_COMMANDS } from "../../source/gateway/gateway-protocol.ts";
import { BOOTSTRAP_FLAG, isPortLike } from "../../source/coordinator/carrier.ts";
import { ClientSideToolV2Relay } from "../../source/adapters/interop/agent/client-side-tool-v2-relay-adapter.ts";
import { probeAgentStoreObject } from "../../source/packages/agent-store-sync/object-probe.ts";
import { TranscriptMirrorProtobufDecodeError } from "../../source/host/transcript/mirror/conversation-state-binary.ts";

describe("the gateway's wire vocabulary", () => {
  it("parses a command's arguments, and tells the loopback interface from the network", () => {
    assert.deepEqual(parseCommandArgs('{"a":1}'), { a: 1 });
    assert.deepEqual(parseCommandArgs(""), {});
    assert.equal(isLoopbackHost("127.0.0.1"), true);
    assert.equal(isLoopbackHost("localhost"), true);
    assert.equal(isLoopbackHost("example.com"), false);
    assert.equal(Object.keys(SLATE_GATEWAY_COMMANDS).length > 100, true);
    assert.equal(Object.keys(SLATE_GATEWAY_SLIM_COMMANDS).length, Object.keys(SLATE_GATEWAY_COMMANDS).length);
  });
});

describe("the carrier the coordinator and the renderer talk over", () => {
  it("names the bootstrap flag and recognizes something it can post to", () => {
    assert.equal(BOOTSTRAP_FLAG, "--bootstrap=");
    // Something with only a `postMessage` is not a port; one that can also be listened to is.
    assert.equal(isPortLike({ postMessage: () => {}, on: () => {} }), true);
    assert.equal(isPortLike({ postMessage: () => {} }), false);
    assert.equal(isPortLike(null), false);
  });
});

describe("relaying a client-side tool call", () => {
  it("is a relay the coordinator can build", () => {
    assert.equal(typeof ClientSideToolV2Relay, "function");
  });
});

describe("asking the store about an object", () => {
  it("is a function a caller can await", () => {
    assert.equal(typeof probeAgentStoreObject, "function");
  });
});

describe("a conversation's state as it is stored", () => {
  it("names the error a record that does not parse raises", () => {
    const error = new TranscriptMirrorProtobufDecodeError("broken");
    assert.equal(error instanceof Error, true);
    assert.equal(error.message, "broken");
  });
});
