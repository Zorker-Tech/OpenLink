import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  getEffectiveNetworkPolicy,
  isNetworkEnabledByPolicy,
  networkAllowAllPolicy,
  networkDisabledPolicy,
} from "../../source/packages/shell-exec/sandbox/network-policy-utils.ts";

describe("the network policy a sandbox runs under", () => {
  it("denies when the command declared nothing", () => {
    assert.deepEqual(getEffectiveNetworkPolicy(undefined), { version: 1, default: "deny" });
    const first = getEffectiveNetworkPolicy(undefined);
    const second = getEffectiveNetworkPolicy(undefined);
    assert.notEqual(first, second, "the default policy is a fresh object each time");
  });

  it("uses the policy a command declared, as it is", () => {
    const declared = { version: 1 as const, default: "allow" as const, allow: ["example.com"] };
    assert.equal(getEffectiveNetworkPolicy(declared), declared);
    assert.equal(getEffectiveNetworkPolicy(null as never), null, "an absent policy is undefined, and only that is replaced");
  });

  it("answers whether the network is enabled", () => {
    assert.equal(isNetworkEnabledByPolicy(undefined), false);
    assert.equal(isNetworkEnabledByPolicy({ version: 1, default: "deny" }), false);
    assert.equal(isNetworkEnabledByPolicy({ version: 1, default: "allow" }), true);
    assert.equal(isNetworkEnabledByPolicy({ version: 1, default: "deny", allow: ["x"] }), true);
    assert.equal(isNetworkEnabledByPolicy({ version: 1, default: "deny", allow: [] }), false, "an empty allow list allows nothing");
    assert.equal(isNetworkEnabledByPolicy({ version: 1, default: "deny", deny: ["x"] }), false);
    assert.throws(() => isNetworkEnabledByPolicy(null as never), TypeError);
  });

  it("builds the two policies the sandbox asks for", () => {
    assert.deepEqual(networkDisabledPolicy(), { version: 1, default: "deny" });
    assert.deepEqual(networkAllowAllPolicy(), { version: 1, default: "allow" });
    assert.notEqual(networkDisabledPolicy(), networkDisabledPolicy());
    assert.notEqual(networkAllowAllPolicy(), networkAllowAllPolicy());
    assert.deepEqual(Object.keys(networkDisabledPolicy()), ["version", "default"]);
  });
});
