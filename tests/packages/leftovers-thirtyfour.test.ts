/**
 * The coordinator's gateway client and what the host's gateway exposes to it.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CoordinatorGatewayClient, CREATE_AGENT_RETRY_POLICY, GatewayEndpointChangedError, HOST_ACCOUNT_SLOT, PERMANENT_REFUSAL_KINDS, PRE_DISPATCH_KINDS } from "../../source/coordinator/gateway/gateway-client.ts";
import { CREATE_AGENT_NONCE_LEDGER_CAP, createHostGatewayApi, DISABLE_SEND_ACCEPT_RETURN_ENV, HOST_CAPABILITIES } from "../../source/gateway/host-gateway-api.ts";

describe("the client the coordinator speaks to the gateway with", () => {
  it("names the account slot it files itself under and the kinds it refuses early", () => {
    assert.equal(HOST_ACCOUNT_SLOT, "host");
    assert.equal(typeof PERMANENT_REFUSAL_KINDS, "object");
    assert.equal(typeof PRE_DISPATCH_KINDS, "object");
    assert.equal(typeof CREATE_AGENT_RETRY_POLICY, "object");
    assert.equal(typeof CoordinatorGatewayClient, "function");
    assert.equal(typeof GatewayEndpointChangedError, "function");
  });
});

describe("what the host's gateway exposes", () => {
  it("lists the capabilities this host offers, and bounds the nonce ledger it keeps", () => {
    assert.deepEqual([...HOST_CAPABILITIES], ["orderedReplicasV1", "sendAcceptanceV1"]);
    assert.equal(CREATE_AGENT_NONCE_LEDGER_CAP, 64);
    assert.equal(DISABLE_SEND_ACCEPT_RETURN_ENV, "SLATE_DISABLE_SEND_ACCEPT_RETURN");
    assert.equal(typeof createHostGatewayApi, "function");
  });
});
