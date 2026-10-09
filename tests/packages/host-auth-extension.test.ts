/**
 * The account, as the host extension declares it: what it says about itself, what it hands the rest of the host, and
 * what it tears down when the host stops.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { HostExtensions } from "../../source/host/extensions/extension-ids.generated.ts";
import { authExtension } from "../../source/host/auth/extension.ts";

async function startAuthExtension() {
  const logged: string[] = [];
  const teardowns: (() => void | Promise<void>)[] = [];
  const api = await authExtension.start({
    deps: {},
    host: { log: (message: string) => void logged.push(message) },
    onStop: (teardown: () => void | Promise<void>) => void teardowns.push(teardown),
  } as never);
  return { api, logged, teardowns };
}

describe("the account, as the host extension declares it", () => {
  it("says it is the account extension, depends on nothing, and hands over the account surface", async () => {
    assert.equal(authExtension.kind, "host-extension");
    assert.equal(authExtension.id, HostExtensions.Auth);
    assert.deepEqual(authExtension.dependencies, []);
    const { api } = await startAuthExtension();
    assert.deepEqual(Object.keys(api).sort(), ["getAccessToken", "getLastRenewalEvent", "getMachineId", "getUserFullName", "peekAccessToken", "subscribeToRenewal"]);
    // Reading the account answers rather than throwing, whatever this machine happens to be signed in as.
    assert.equal(typeof api.getAccessToken, "function");
    assert.equal(typeof api.getMachineId, "function");
    const name = api.getUserFullName();
    assert.equal(name === undefined || typeof name === "string", true);
    const unsubscribe = api.subscribeToRenewal(() => {});
    assert.equal(typeof unsubscribe, "function");
    unsubscribe();
  });

  it("tears down the account service and the renewal subscription it opened", async () => {
    const { teardowns } = await startAuthExtension();
    assert.equal(teardowns.length, 2);
    for (const teardown of teardowns) await teardown();
    for (const teardown of teardowns) await teardown();
  });
});
