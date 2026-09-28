/**
 * The platform's configuration module: how a request says it came from the command line, fetching through
 * the machine's proxy, the managed sign-in policy, and the empty boundary the token refresh names.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isLocalCliMode, LOCAL_CLI_MODE_ENV, LOCAL_CLI_MODE_HEADER } from "../../source/packages/config/request.ts";
import { proxyFetch } from "../../source/packages/config/auth/proxy-fetch.ts";
import { MDM_SIGN_IN_POLICY_HEADER_NAME, POLICY_CACHE_TTL_MS, readMdmSignInPolicyHeaderValue, SIGN_IN_POLICY_VIOLATION_ERROR, SIGN_IN_POLICY_VIOLATION_MESSAGE } from "../../source/packages/config/auth/mdm-sign-in-policy.ts";

describe("how a request says it came from the command line", () => {
  it("reads the mode from the environment, and has a header of its own", () => {
    assert.equal(LOCAL_CLI_MODE_ENV, "CURSOR_AGENT_CLI_LOCAL_MODE");
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
