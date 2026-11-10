/**
 * The platform's configuration module: how a request says it came from the command line, fetching through
 * the machine's proxy, the managed sign-in policy, and the empty boundary the token refresh names.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { applyLocalCliModeHeader, createLocalCliModeHeaders, isLocalCliMode, LOCAL_CLI_MODE_ENV, LOCAL_CLI_MODE_HEADER } from "../../source/packages/config/request.ts";
import { proxyFetch } from "../../source/packages/config/auth/proxy-fetch.ts";
import { MDM_SIGN_IN_POLICY_HEADER_NAME, POLICY_CACHE_TTL_MS, readMdmSignInPolicyHeaderValue, SIGN_IN_POLICY_VIOLATION_ERROR, SIGN_IN_POLICY_VIOLATION_MESSAGE } from "../../source/packages/config/auth/mdm-sign-in-policy.ts";

describe("how a request says it came from the command line", () => {
  it("reads the mode from the environment, and has a header of its own", () => {
    assert.equal(LOCAL_CLI_MODE_ENV, "SLATE_AGENT_CLI_LOCAL_MODE");
    assert.equal(LOCAL_CLI_MODE_HEADER, "local-cli-mode");
    const previous = process.env[LOCAL_CLI_MODE_ENV];
    // Only the exact word turns it on — "1" and "yes" do not.
    process.env[LOCAL_CLI_MODE_ENV] = "true";
    assert.equal(isLocalCliMode(), true);
    process.env[LOCAL_CLI_MODE_ENV] = "1";
    assert.equal(isLocalCliMode(), false);
    delete process.env[LOCAL_CLI_MODE_ENV];
    assert.equal(isLocalCliMode(), false);
    if (previous !== undefined) process.env[LOCAL_CLI_MODE_ENV] = previous;
  });

  it("marks a request's headers while the mode is on, and hands them back untouched while it is off", () => {
    const previous = process.env[LOCAL_CLI_MODE_ENV];
    try {
      process.env[LOCAL_CLI_MODE_ENV] = "true";
      const marked = new Headers({ "x-other": "1" });
      applyLocalCliModeHeader(marked);
      assert.equal(marked.get(LOCAL_CLI_MODE_HEADER), "true");
      assert.equal(marked.get("x-other"), "1", "the request's own headers are kept");
      assert.deepEqual(createLocalCliModeHeaders({ a: "1" }), { a: "1", [LOCAL_CLI_MODE_HEADER]: "true" });
      assert.deepEqual(createLocalCliModeHeaders({ [LOCAL_CLI_MODE_HEADER]: "old" }), { [LOCAL_CLI_MODE_HEADER]: "true" }, "the mode's header wins over a stored one");

      process.env[LOCAL_CLI_MODE_ENV] = "1";
      const untouched = new Headers({ "x-other": "1" });
      applyLocalCliModeHeader(untouched);
      assert.equal(untouched.has(LOCAL_CLI_MODE_HEADER), false);
      assert.equal(untouched.get("x-other"), "1");
      const input = { a: "1" };
      assert.equal(createLocalCliModeHeaders(input), input, "with the mode off the very same object comes back");
      assert.equal(createLocalCliModeHeaders(undefined), undefined);
      assert.deepEqual(createLocalCliModeHeaders({}), {});
    } finally {
      if (previous === undefined) delete process.env[LOCAL_CLI_MODE_ENV];
      else process.env[LOCAL_CLI_MODE_ENV] = previous;
    }
  });
});

describe("fetching through the machine's proxy", () => {
  it("has something to fetch with", () => {
    assert.equal(typeof proxyFetch, "function");
  });
});

describe("the managed sign-in policy", () => {
  it("names the header the policy travels in and how long a reading is kept", () => {
    assert.equal(MDM_SIGN_IN_POLICY_HEADER_NAME, "x-slate-mdm-signin-policy");
    assert.equal(POLICY_CACHE_TTL_MS, 30_000);
    assert.equal(SIGN_IN_POLICY_VIOLATION_ERROR.length > 0, true);
    assert.equal(SIGN_IN_POLICY_VIOLATION_MESSAGE.length > 0, true);
    assert.equal(typeof readMdmSignInPolicyHeaderValue, "function");
  });
});
