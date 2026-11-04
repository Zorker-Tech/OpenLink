/**
 * The RPC contracts, the account's MCP listing, the login flow and the search-index worker.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { COORDINATOR_CANCELLED, COORDINATOR_CONTROL_CHANNEL, COORDINATOR_PROTOCOL_VERSION, COORDINATOR_UNKNOWN_METHOD } from "../../source/shared/rpc/coordinator-port.ts";
import { MAIN_METHOD_TABLE, MAIN_RPC_CONTRACT_NAME, MAIN_RPC_EVENT_FAMILY } from "../../source/shared/rpc/main.ts";
import { ACCOUNT_MCP_RPC_TIMEOUT_MS } from "../../source/adapters/interop/cursor-backend/account-mcp.ts";
import { startSearchIndexWorker } from "../../source/host/extensions/content-search/search-index-worker.ts";
import { AuthNetworkError, generateAuthParams, LoginManager } from "../../source/packages/config/auth/login.ts";

describe("the port the coordinator answers on", () => {
  it("names its protocol and the two failures a caller acts on", () => {
    assert.equal(COORDINATOR_PROTOCOL_VERSION, 1);
    assert.equal(COORDINATOR_UNKNOWN_METHOD, "unknown-method");
    assert.equal(COORDINATOR_CANCELLED, "cancelled");
    assert.equal(typeof COORDINATOR_CONTROL_CHANNEL, "string");
  });
});

describe("the main process's RPC surface", () => {
  it("names every method with the shape of its argument", () => {
    assert.equal(MAIN_RPC_CONTRACT_NAME, "main");
    assert.equal(MAIN_RPC_EVENT_FAMILY, "events");
    assert.equal(Object.keys(MAIN_METHOD_TABLE).length > 100, true);
    assert.equal(typeof MAIN_METHOD_TABLE.openExternal, "object");
  });
});

describe("the MCP servers an account has", () => {
  it("has its own timeout for the listing", () => {
    assert.equal(ACCOUNT_MCP_RPC_TIMEOUT_MS, 30_000);
  });
});

describe("indexing a transcript in a worker", () => {
  it("is started by the host rather than imported for effect", () => {
    assert.equal(typeof startSearchIndexWorker, "function");
  });
});

describe("signing a user in", () => {
  it("builds an authorization request, and names the failure when the network is what broke", () => {
    const params = generateAuthParams();
    assert.equal(typeof params, "object");
    // The error writes its own message, naming the proxy a user should check.
    const error = new AuthNetworkError("ignored");
    assert.equal(error instanceof Error, true);
    assert.match(error.message, /Failed to reach the Slate API/);
    assert.equal(typeof LoginManager, "function");
  });
});
