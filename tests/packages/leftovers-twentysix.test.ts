/**
 * Bringing the experiment client up, where automations are kept, the transport stage record, gateway
 * reachability, the egress exit client, structured logs and the notification bus.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { BOOTSTRAP_CACHE_FILENAME, STATSIG_CLIENT_KEY } from "../../source/shared/node/experiments/statsig-bootstrap.ts";
import { AUTOMATIONS_DIRNAME, AUTOMATION_CHANGE_DEBOUNCE_MS, CONFIG_FILENAME, FileAutomationStore, RUNS_FILENAME } from "../../source/host/automations/automation-store.ts";
import { MAX_IN_FLIGHT_TRANSPORT_REPORTS, PENDING_SEND_ECHO_MAX, SSE_ECHO_STAGE } from "../../source/coordinator/telemetry/transport-stage-recorder.ts";
import { classifyBaseUrlKind, classifyGatewayError, classifyGatewayFetchFailure, SlateGatewayUnreachableError } from "../../source/coordinator/gateway/gateway-reachability.ts";
import { EgressTunnelExitClient, RECONNECT_INITIAL_DELAY_MS, RECONNECT_MAX_DELAY_MS } from "../../source/shared/node/egress-tunnel/exit-client.ts";
import { DEADLINE_EXPIRY_CODE, MAX_BUFFER_SIZE, STRUCTURED_LOG_SUBMIT_DEADLINE_MS } from "../../source/shared/observability/structured-log-transport.ts";
import { HEALTHY_CONNECTION_MIN_LIFETIME_MS, SLATE_NOTIFY_TOPICS, SlateNotifyBusClient } from "../../source/host/extensions/notify-bus/notify-bus-client.ts";

describe("bringing the experiment client up", () => {
  it("reads what was cached first, and holds no key of another product", () => {
    assert.equal(BOOTSTRAP_CACHE_FILENAME.length > 0, true);
    assert.equal(typeof STATSIG_CLIENT_KEY, "string");
    assert.equal(STATSIG_CLIENT_KEY.includes("cursor"), false);
  });
});

describe("where an agent's automations are kept", () => {
  it("is its own directory beside the agent, with a config and a runs file", () => {
    assert.equal(AUTOMATIONS_DIRNAME, "automations");
    assert.equal(CONFIG_FILENAME, "automation.json");
    assert.equal(RUNS_FILENAME, "runs.json");
    assert.equal(AUTOMATION_CHANGE_DEBOUNCE_MS, 50);
    assert.equal(typeof FileAutomationStore, "function");
  });
});

describe("recording what each stage of a transport did", () => {
  it("bounds what is in flight and what an echo may hold", () => {
    assert.equal(MAX_IN_FLIGHT_TRANSPORT_REPORTS, 64);
    assert.equal(PENDING_SEND_ECHO_MAX, 64);
    assert.equal(SSE_ECHO_STAGE, "echo-coordinator-sse");
  });
});

describe("whether the host's gateway can be reached", () => {
  it("classifies what a caller can act on", () => {
    assert.equal(typeof classifyBaseUrlKind, "function");
    assert.equal(typeof classifyGatewayError, "function");
    assert.equal(typeof classifyGatewayFetchFailure, "function");
    assert.equal(typeof SlateGatewayUnreachableError, "function");
  });
});

describe("reaching the network through an egress exit", () => {
  it("reconnects with a bounded backoff", () => {
    assert.equal(typeof EgressTunnelExitClient, "function");
    assert.equal(RECONNECT_INITIAL_DELAY_MS > 0, true);
    assert.equal(RECONNECT_MAX_DELAY_MS >= RECONNECT_INITIAL_DELAY_MS, true);
  });
});

describe("where the platform's structured logs go", () => {
  it("buffers up to a bound and gives a submission a deadline", () => {
    assert.equal(MAX_BUFFER_SIZE, 1_000);
    assert.equal(STRUCTURED_LOG_SUBMIT_DEADLINE_MS, 15_000);
    assert.equal(DEADLINE_EXPIRY_CODE, "deadline_exceeded");
  });
});

describe("the client the host reaches the notification bus with", () => {
  it("names the topics it publishes and how long a connection must last to count", () => {
    assert.equal(SLATE_NOTIFY_TOPICS.length, 3);
    assert.equal(HEALTHY_CONNECTION_MIN_LIFETIME_MS, 30_000);
    assert.equal(typeof SlateNotifyBusClient, "function");
  });
});
