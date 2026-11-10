/**
 * The name the account goes by: what counts as a name at all, how a first and last name are put together, and the
 * resolver that reads the name for the account that is signed in — once, keeping what it read only while that account
 * is still the one signed in.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createSlateUserFullNameResolver,
  displayNameFrom,
  GET_ME_TIMEOUT_MS,
  nonEmpty,
} from "../../source/host/auth/user-full-name-service.ts";

/** A token carrying the account it belongs to, the way the platform's own tokens do. */
function tokenFor(principal: string): string {
  const payload = Buffer.from(JSON.stringify({ sub: principal }), "utf8").toString("base64url");
  return `header.${payload}.signature`;
}

function resolverWorld(options: { name?: string | null; fetchFails?: boolean; tokenFails?: boolean; tokenFor?: string } = {}) {
  const fetched: string[] = [];
  const logged: string[] = [];
  let peeked: string | null = tokenFor("account-1");
  const resolver = createSlateUserFullNameResolver({
    getAccessToken: async () => {
      if (options.tokenFails === true) throw new Error("no token today");
      return options.tokenFor ?? peeked ?? tokenFor("account-1");
    },
    peekAccessToken: () => peeked,
    getMachineId: async () => "machine-1",
    fetchFullName: async (accessToken: string) => {
      fetched.push(accessToken);
      if (options.fetchFails === true) throw new Error("the backend is down");
      if (options.name === null) return undefined;
      return options.name === undefined ? "Ada Lovelace" : options.name;
    },
    log: (message: string) => logged.push(message),
  });
  return { resolver, fetched, logged, signIn: (principal: string) => (peeked = tokenFor(principal)), signOut: () => (peeked = null) };
}

describe("what counts as a name", () => {
  it("keeps a name that has anything in it, and nothing else", () => {
    assert.equal(nonEmpty("  Ada  "), "Ada");
    assert.deepEqual([nonEmpty(""), nonEmpty("   "), nonEmpty(null), nonEmpty(undefined)], [undefined, undefined, undefined, undefined]);
    assert.equal(GET_ME_TIMEOUT_MS, 10_000);
  });

  it("puts a first and last name together, dropping what is not there", () => {
    assert.deepEqual(
      [
        displayNameFrom({ firstName: "Ada", lastName: "Lovelace" }),
        displayNameFrom({ firstName: " Ada ", lastName: "  " }),
        displayNameFrom({ lastName: "Lovelace" }),
        displayNameFrom({ firstName: "Ada" }),
        displayNameFrom({}),
      ],
      ["Ada Lovelace", "Ada", "Lovelace", "Ada", undefined],
    );
  });
});

describe("the name of the account that is signed in", () => {
  it("reads the name once for the account, and answers with it while that account is signed in", async () => {
    const world = resolverWorld();
    assert.equal(world.resolver.getUserFullName(), undefined);
    await world.resolver.refresh();
    assert.deepEqual([world.fetched.length, world.resolver.getUserFullName()], [1, "Ada Lovelace"]);
    assert.equal(world.fetched[0], tokenFor("account-1"));
    // The same account again is not read again, and something else entirely does not have that name.
    await world.resolver.refresh();
    assert.deepEqual(world.fetched.length, 1);
    world.signIn("account-2");
    assert.equal(world.resolver.getUserFullName(), undefined);
    await world.resolver.refresh();
    assert.deepEqual([world.fetched.length, world.resolver.getUserFullName()], [2, "Ada Lovelace"]);
    // Signing out takes the name with it.
    world.signOut();
    assert.equal(world.resolver.getUserFullName(), undefined);
    await world.resolver.refresh();
    assert.deepEqual(world.fetched.length, 2);
  });

  it("reads the name once even when it is asked for twice at once, and only for the account that asked", async () => {
    const world = resolverWorld();
    await Promise.all([world.resolver.refresh(), world.resolver.refresh()]);
    assert.deepEqual(world.fetched.length, 1);
    // A name that came back for another account is not adopted.
    const crossed = resolverWorld();
    await crossed.resolver.refresh();
    crossed.signIn("account-2");
    await crossed.resolver.refresh();
    assert.deepEqual([crossed.fetched.length, crossed.resolver.getUserFullName()], [2, "Ada Lovelace"]);
    // An account whose token cannot be had, or whose name cannot be read, keeps no name — and says so.
    const noToken = resolverWorld({ tokenFails: true });
    await noToken.resolver.refresh();
    assert.deepEqual([noToken.fetched.length, noToken.resolver.getUserFullName(), noToken.logged.length], [0, undefined, 1]);
    assert.equal(noToken.logged[0]?.startsWith("user full-name resolve failed:"), true);
    const failing = resolverWorld({ fetchFails: true });
    await failing.resolver.refresh();
    assert.deepEqual([failing.resolver.getUserFullName(), failing.logged.length], [undefined, 1]);
    // A token that turned out to belong to another account does not name this one.
    const crossedToken = resolverWorld({ tokenFor: tokenFor("account-9") });
    await crossedToken.resolver.refresh();
    assert.deepEqual([crossedToken.fetched.length, crossedToken.resolver.getUserFullName()], [0, undefined]);
    // A backend that knows no name is still an answer, and what the resolver was handed is what it keeps — the
    // backend path trims and drops an empty name before it ever gets here.
    const nameless = resolverWorld({ name: null });
    const handedEmpty = resolverWorld({ name: "" });
    await nameless.resolver.refresh();
    await handedEmpty.resolver.refresh();
    assert.deepEqual([nameless.resolver.getUserFullName(), handedEmpty.resolver.getUserFullName()], [undefined, ""]);
    await nameless.resolver.refresh();
    assert.deepEqual(nameless.fetched.length, 1);
  });
});
