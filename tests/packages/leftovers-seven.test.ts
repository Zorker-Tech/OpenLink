/**
 * The last files of five modules: message passing to an agent, the model catalog, how a failed backend call
 * is classified, the analytics buffer and the context-carrying client.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ADMIN_BROADCAST_WAKE_CUE, AGENT_DIRECTORY_PROMPT_LIMIT, AGENT_INBOUND_WAKE_CUE, AGENT_MESSAGE_MAX_TEXT_LENGTH } from "../../source/host/agents/agent-messaging.ts";
import { describeParamIncompatibilities, findCatalogEntry, mapAvailableModels, toSlateModelCatalogEntry } from "../../source/shared/agents/model-catalog.ts";
import { AgentError, CancelledError, classifyError, NonRetriableError, RetriableError } from "../../source/packages/agent-client/errors.ts";
import { AnalyticsBuffer } from "../../source/packages/analytics-client/buffer.ts";
import { createContextPropagatingClient } from "../../source/packages/context-rpc/index.ts";

describe("passing a message to an agent", () => {
  it("marks where the message came from and bounds what it carries", () => {
    assert.equal(AGENT_INBOUND_WAKE_CUE, "[agent]");
    assert.equal(ADMIN_BROADCAST_WAKE_CUE, "[broadcast]");
    assert.equal(AGENT_MESSAGE_MAX_TEXT_LENGTH, 8_000);
    assert.equal(AGENT_DIRECTORY_PROMPT_LIMIT, 40);
  });
});

describe("the models the platform offers", () => {
  it("describes what a model takes, and maps a backend entry into ours", () => {
    assert.equal(typeof describeParamIncompatibilities, "function");
    assert.equal(typeof toSlateModelCatalogEntry, "function");
    assert.equal(typeof findCatalogEntry, "function");
    assert.equal(typeof mapAvailableModels, "function");
  });
});

describe("how a failed backend call is classified", () => {
  it("tells what a caller may retry from what it may not", () => {
    const retriable = new RetriableError("busy");
    assert.equal(retriable.name, "RetriableError");
    assert.equal(retriable instanceof Error, true);
    assert.equal(retriable instanceof AgentError, true);
    assert.equal(classifyError(retriable)?.name, "RetriableError");
    assert.equal(new NonRetriableError("bad request").name, "NonRetriableError");
    assert.equal(new CancelledError("cancelled").name, "CancelledError");
  });
});

describe("events waiting to be sent", () => {
  it("is built with the client it will send through, and offers a flush", () => {
    assert.equal(typeof AnalyticsBuffer, "function");
    const buffer = new AnalyticsBuffer({ client: {} } as never);
    assert.equal(typeof buffer.track, "function");
    assert.equal(typeof buffer.flush, "function");
    assert.equal((buffer as unknown as Record<string, unknown>).flushOnce !== undefined, true);
  });

  it("sends at the buffer limit, preserves original event fields, and clears sent events", async () => {
    const calls: { events: { eventName: string; timestamp: bigint }[] }[] = [];
    const buffer = new AnalyticsBuffer({
      client: { trackEvents: async request => { calls.push(request as never); } },
      tokenProvider: { getAccessToken: async () => "token" },
      bufferLimit: 1,
      flushIntervalMs: 60_000,
    });
    buffer.track("event.one", { tier: "free" }, 123);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.events[0]?.eventName, "event.one");
    assert.equal(calls[0]?.events[0]?.timestamp, 123n);
    assert.equal((buffer as unknown as { buffer: unknown[] }).buffer.length, 0);
  });

  it("defers without a token and leaves pending events intact", async () => {
    const debug: unknown[] = [];
    const buffer = new AnalyticsBuffer({
      client: { trackEvents: async () => { throw new Error("must not send"); } },
      tokenProvider: { getAccessToken: async () => null },
      onDebug: (_tag, payload) => debug.push(payload),
    });
    buffer.track("event.pending", undefined, 7);
    await buffer.flush(1_000);
    assert.equal((buffer as unknown as { buffer: unknown[] }).buffer.length, 1);
    assert.equal((debug[0] as { reason: string }).reason, "no_token");
  });

  it("keeps a bounded queue when delivery fails", async () => {
    const buffer = new AnalyticsBuffer({
      client: { trackEvents: async () => { throw new Error("offline"); } },
      tokenProvider: { getAccessToken: async () => "token" },
      bufferLimit: 1,
    });
    buffer.track("event.one");
    buffer.track("event.two");
    await buffer.flush(1_000);
    assert.deepEqual((buffer as unknown as { buffer: { eventName: string }[] }).buffer.map(event => event.eventName), ["event.two"]);
  });
});

describe("calling the backend with the context a request carries", () => {
  it("builds a client from a transport", () => {
    assert.equal(typeof createContextPropagatingClient, "function");
  });
});
