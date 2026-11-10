/**
 * A websocket over the tunnel, dispatching a gateway request, the workflow store, the notify-bus entry,
 * RPC tracing, the machine as a provider and diagnosing a gateway that cannot be reached.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createWebSocket, constructEgressWebSocket, EGRESS_TUNNEL_OPEN_READY_STATE, type EgressWebSocketConstructor } from "../../source/adapters/interop/egress-tunnel/websocket-client-adapter.ts";
import type { ExitWebSocket } from "../../source/shared/node/egress-tunnel/exit-client.ts";
import { createGatewayRequestDispatch, GATEWAY_COMMAND_FAILED, GATEWAY_TRANSPORT_FAILED, GATEWAY_UNREACHABLE } from "../../source/coordinator/gateway/gateway-request-dispatcher.ts";
import { FileWorkflowStore, LEGACY_WORKFLOWS_DIRNAME, MANAGED_SKILLS_CHANGE_DEBOUNCE_MS } from "../../source/host/workflows/workflow-store.ts";
import { NOTIFY_STREAM_STALL_MS } from "../../source/host/extensions/notify-bus/extension.ts";
import { createSlateRpcTracingInterceptor, SLATE_RPC_TRACE_WINDOW_DURATION_MS } from "../../source/adapters/interop/slate-backend/rpc-tracing.ts";
import { DEFAULT_SLATE_COMPUTER_ID, SSE_RECONNECT_MAX_MS, SSE_RECONNECT_MIN_MS } from "../../source/host/local-exec/local-exec-provider.ts";
import { DNS_PROBE_MIN_INTERVAL_MS, DNS_PROBE_TIMEOUT_MS, GENERAL_CONTROL_HOSTNAME } from "../../source/coordinator/gateway/gateway-dns-diagnostics.ts";

describe("a websocket over the egress tunnel", () => {
  it("opens in the ready state the tunnel defines", () => {
    assert.equal(typeof createWebSocket, "function");
    assert.equal(EGRESS_TUNNEL_OPEN_READY_STATE, 1);
  });

  it("forwards the address and headers to the supplied websocket implementation", () => {
    const socket = {} as ExitWebSocket;
    let received: unknown;
    const FakeWebSocket = function (url: string, options: { headers: Record<string, string> }): unknown {
      received = { url, options };
      return socket;
    } as unknown as EgressWebSocketConstructor;
    const client = constructEgressWebSocket(
      FakeWebSocket,
      "wss://exit.example/tunnel",
      { headers: { Authorization: "Bearer test" } },
    );

    assert.equal(client, socket);
    assert.deepEqual(received, {
      url: "wss://exit.example/tunnel",
      options: { headers: { Authorization: "Bearer test" } },
    });
  });
});

describe("sending a request to the host's gateway", () => {
  it("names the three failures a caller acts on", () => {
    assert.equal(GATEWAY_UNREACHABLE, "gateway-unreachable");
    assert.equal(GATEWAY_TRANSPORT_FAILED, "gateway-transport-failed");
    assert.equal(GATEWAY_COMMAND_FAILED, "gateway-command-failed");
    assert.equal(typeof createGatewayRequestDispatch, "function");
  });
});

describe("where an agent's workflows are kept", () => {
  it("is a file store beside the agent, with the legacy directory named", () => {
    assert.equal(LEGACY_WORKFLOWS_DIRNAME, "workflows");
    assert.equal(MANAGED_SKILLS_CHANGE_DEBOUNCE_MS, 50);
    assert.equal(typeof FileWorkflowStore, "function");
  });
});

describe("the notify-bus entry", () => {
  it("gives a stalled stream its own bound", () => {
    assert.equal(NOTIFY_STREAM_STALL_MS, 35_000);
  });
});

describe("tracing a call to the backend", () => {
  it("traces over its own window", () => {
    assert.equal(SLATE_RPC_TRACE_WINDOW_DURATION_MS, 120_000);
    assert.equal(typeof createSlateRpcTracingInterceptor, "function");
  });
});

describe("the machine as a provider", () => {
  it("has one identity, and reconnects its stream between two bounds", () => {
    assert.equal(DEFAULT_SLATE_COMPUTER_ID, "this-computer");
    assert.equal(SSE_RECONNECT_MIN_MS, 1_000);
    assert.equal(SSE_RECONNECT_MAX_MS, 10_000);
  });
});

describe("diagnosing a gateway that cannot be reached", () => {
  it("probes our own control host, bounded in time and frequency", () => {
    assert.equal(GENERAL_CONTROL_HOSTNAME, "api.slate.invalid");
    assert.equal(DNS_PROBE_TIMEOUT_MS, 2_000);
    assert.equal(DNS_PROBE_MIN_INTERVAL_MS, 60_000);
  });
});
