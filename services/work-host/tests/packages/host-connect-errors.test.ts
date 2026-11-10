import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Code, ConnectError } from "@connectrpc/connect";

import {
  carriesConnectCode,
  mintFailureIsCacheable,
  syncIsDisabledForAccount,
} from "../../source/packages/agent-store-sync/connect-errors.ts";

describe("the code a failed store call carries", () => {
  it("is read from the transport's own error, and from one that copied its shape", () => {
    assert.equal(carriesConnectCode(new ConnectError("x", Code.InvalidArgument), Code.InvalidArgument), true);
    // The transport names its codes in the enum's own spelling, which is what a copied shape carries.
    assert.equal(carriesConnectCode({ code: "InvalidArgument" }, Code.InvalidArgument), true);
    assert.equal(carriesConnectCode({ code: "invalid_argument" }, Code.InvalidArgument), false, "the wire spelling is not the enum's");
    assert.equal(carriesConnectCode({ code: Code.NotFound }, Code.NotFound), true);
    assert.equal(carriesConnectCode({ code: "nope" }, Code.NotFound), false);
    assert.equal(carriesConnectCode({ code: 99 }, Code.NotFound), false);
    assert.equal(carriesConnectCode({ code: "nope" }, 0), false, "a code this build does not know is no code at all");
    assert.equal(carriesConnectCode(new Error("plain"), Code.NotFound), false);
    for (const value of [null, undefined, 5, "text"]) assert.equal(carriesConnectCode(value, Code.NotFound), false, String(value));
  });
});

describe("a mint failure worth remembering", () => {
  it("is one where the request itself was wrong", () => {
    for (const code of [Code.InvalidArgument, Code.NotFound, Code.FailedPrecondition]) {
      assert.equal(mintFailureIsCacheable(new ConnectError("x", code)), true, String(code));
    }
    for (const code of [Code.Unavailable, Code.PermissionDenied, Code.Internal]) {
      assert.equal(mintFailureIsCacheable(new ConnectError("x", code)), false, String(code));
    }
    assert.equal(mintFailureIsCacheable(new Error("no code")), false);
  });
});

describe("a refusal because sync is not enabled", () => {
  it("is decided by the words, whatever the error carries", () => {
    assert.equal(syncIsDisabledForAccount(new Error("agent store sync is not enabled")), true);
    assert.equal(syncIsDisabledForAccount(new Error("AGENT STORE SYNC IS NOT AVAILABLE IN LEGACY PRIVACY MODE")), true);
    assert.equal(syncIsDisabledForAccount("private worker agent-store sync is not enabled"), true);
    assert.equal(syncIsDisabledForAccount(new Error("something else")), false);
    assert.equal(syncIsDisabledForAccount(null), false);
  });

  it("is a refusal's own code when a code came with it", () => {
    assert.equal(syncIsDisabledForAccount(Object.assign(new Error("agent store sync is not enabled"), { code: Code.PermissionDenied })), true);
    assert.equal(syncIsDisabledForAccount(Object.assign(new Error("agent store sync is not enabled"), { code: Code.InvalidArgument })), true);
    assert.equal(syncIsDisabledForAccount(Object.assign(new Error("agent store sync is not enabled"), { code: Code.Unavailable })), false, "an outage is not a refusal");
  });
});
