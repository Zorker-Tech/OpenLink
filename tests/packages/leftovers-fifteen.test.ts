/**
 * The gateway server, a turn's own telemetry, the auto-review an agent can be put under, the settings
 * store and an agent database that had to be rebuilt.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { GATEWAY_REQUEST_ID_HEADER, SlateGatewayRequestError, SSE_HEARTBEAT_MS } from "../../source/gateway/gateway-server.ts";
import { TURN_AWAIT_EVENT, TURN_INTERRUPT_EVENT, TURN_RETRY_EVENT } from "../../source/host/telemetry/turn-telemetry-mappers.ts";
import { SLATE_AUTO_REVIEW_APPROVAL_TTL_MS, SLATE_AUTO_REVIEW_MAX_PENDING_PER_AGENT } from "../../source/host/runner/slate-auto-review.ts";
import { SlateSettingsStore } from "../../source/shared/node/settings/slate-settings-store.ts";
import { isStoreDbHealthy, recoverCorruptStoreDb, SlateAgentDbIntegrityError } from "../../source/host/extensions/session/agent-db-recovery.ts";

describe("the gateway a client reaches the host through", () => {
  it("names the request-id header after us, and keeps the heartbeats coming", () => {
    assert.equal(GATEWAY_REQUEST_ID_HEADER, "x-slate-request-id");
    assert.equal(SSE_HEARTBEAT_MS, 15_000);
    assert.equal(new SlateGatewayRequestError("bad").message, "bad");
  });
});

describe("a turn's own telemetry", () => {
  it("reports an interrupt under our own event name", () => {
    assert.equal(TURN_INTERRUPT_EVENT, "slate.turn.interrupt");
    assert.equal(TURN_AWAIT_EVENT, "slate.turn.await");
    assert.equal(TURN_RETRY_EVENT, "slate.turn.retry");
  });
});

describe("the auto-review an agent can be put under", () => {
  it("bounds how long an approval waits and how many may wait at once", () => {
    assert.equal(SLATE_AUTO_REVIEW_APPROVAL_TTL_MS, 600_000);
    assert.equal(SLATE_AUTO_REVIEW_MAX_PENDING_PER_AGENT, 4);
  });
});

describe("where the platform keeps a user's own settings", () => {
  it("is a store a caller can build, defaulting the provider to us", () => {
    assert.equal(typeof SlateSettingsStore, "function");
  });
});

describe("recovering an agent's database", () => {
  it("can be asked whether a store is healthy, and can rebuild one that is not", () => {
    assert.equal(typeof isStoreDbHealthy, "function");
    assert.equal(typeof recoverCorruptStoreDb, "function");
    assert.equal(new SlateAgentDbIntegrityError("broken").message, "broken");
  });
});
