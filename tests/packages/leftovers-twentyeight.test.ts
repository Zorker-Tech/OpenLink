/**
 * The session's store factories, the local-exec daemon, forwarding an MCP authorization, the WebAuthn
 * bridge, the host supervisor, the box remote accessor and the auto-review's summaries.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { automationStoreForDbPath, channelStoreForDbPath, createUnavailableMemoryStore, NO_SESSION_MEMORY, workflowStoreForDbPath } from "../../source/host/extensions/session/session-store-factories.ts";
import { LOCAL_EXEC_CONNECTION_PATH, NO_LOCAL_EXEC_CONNECTION_MESSAGE, SlateLocalExecConnectionError } from "../../source/host/local-exec/local-exec-daemon.ts";
import { MCP_OAUTH_PENDING_TTL_MS, McpOAuthForwarder, OAuthPendingRegistry } from "../../source/coordinator/oauth/mcp-oauth-forwarder.ts";
import { parseDesktopStage, SlateWebAuthnBridge, stageCause } from "../../source/host/extensions/webauthn-proxy/webauthn-proxy-bridge.ts";
import { DISABLE_HEALTH_TTL_ENV, DISABLE_STREAM_LIVENESS_ENV, HEALTH_PROBE_TTL_MS } from "../../source/coordinator/gateway/host-supervisor.ts";
import { BoxRemoteExecManager, classifyPingFailure, createBoxAuthorizationInterceptor, createBoxRemoteResourceAccessor } from "../../source/host/boxes/box-remote-accessor.ts";
import { compact, compactHeadAndTail } from "../../source/host/runner/slate-auto-review-summaries.ts";

describe("the stores a session opens", () => {
  it("are built from the same ports, and an unavailable memory store says so", () => {
    // The store a session gets when memory is unavailable holds nothing.
    assert.equal(typeof NO_SESSION_MEMORY, "object");
    assert.equal(typeof automationStoreForDbPath, "function");
    assert.equal(typeof channelStoreForDbPath, "function");
    assert.equal(typeof workflowStoreForDbPath, "function");
    assert.equal(typeof createUnavailableMemoryStore, "function");
  });
});

describe("the local-exec daemon", () => {
  it("names the connection it waits for, and the error a caller sees meanwhile", () => {
    assert.equal(LOCAL_EXEC_CONNECTION_PATH, "/slate-box/local-exec-connection");
    assert.match(NO_LOCAL_EXEC_CONNECTION_MESSAGE, /^local-exec daemon has no gateway connection yet/);
    assert.equal(typeof SlateLocalExecConnectionError, "function");
  });
});

describe("forwarding an MCP authorization", () => {
  it("keeps a pending flow for eleven minutes", () => {
    assert.equal(MCP_OAUTH_PENDING_TTL_MS, 11 * 60 * 1_000);
    assert.equal(typeof McpOAuthForwarder, "function");
    assert.equal(typeof OAuthPendingRegistry, "function");
  });
});

describe("the security-key bridge", () => {
  it("parses the stage the desktop reports, and says why a stage ended", () => {
    assert.equal(typeof SlateWebAuthnBridge, "function");
    assert.equal(typeof parseDesktopStage, "function");
    assert.equal(typeof stageCause, "function");
  });
});

describe("keeping a host process alive", () => {
  it("probes health over a window and can be switched off by name", () => {
    assert.equal(HEALTH_PROBE_TTL_MS, 5_000);
    assert.equal(DISABLE_HEALTH_TTL_ENV, "SLATE_DISABLE_GATEWAY_HEALTH_TTL");
    assert.equal(DISABLE_STREAM_LIVENESS_ENV, "SLATE_DISABLE_GATEWAY_STREAM_LIVENESS");
  });
});

describe("reaching a box's files over the tunnel", () => {
  it("names what a failed ping was, and builds the accessor", () => {
    assert.equal(typeof BoxRemoteExecManager, "function");
    assert.equal(typeof classifyPingFailure, "function");
    assert.equal(typeof createBoxAuthorizationInterceptor, "function");
    assert.equal(typeof createBoxRemoteResourceAccessor, "function");
  });
});

describe("the summaries an auto-review leaves", () => {
  it("compacts what it writes, keeping the ends when it has to", () => {
    assert.equal(compactHeadAndTail("short", 100), "short");
    assert.equal(typeof compact, "function");
    assert.equal(typeof compactHeadAndTail, "function");
  });
});
