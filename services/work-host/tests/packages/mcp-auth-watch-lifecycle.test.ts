/**
 * Watching a connector's authorization while it is pending.
 *
 * What is pinned here is the start of a sign-in (every refusal and failure the tool answers with, and the events the
 * connector surface sees), the pending watch's bounded polling (first-poll suppression, expiry, a landed token, a
 * server that disappeared), and every way a watch is cleared or announced.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CONNECTOR_AUTH_START_FAILURE_REASONS,
  CONNECTOR_AUTH_START_REFUSAL_REASONS,
  SlateMcpAuthWatchLifecycle,
} from "../../source/shared/node/mcp/mcp-auth-watch-lifecycle.ts";
import { authWatchKey } from "../../source/shared/node/mcp/mcp-auth-watch.ts";
import { MCP_OAUTH_LOOPBACK_CALLBACK_URL } from "../../source/shared/node/mcp/mcp-oauth-loopback.ts";
import { stripMarkupAndBoundConnectorError } from "../../source/shared/mcp.ts";

// ---------------------------------------------------------------------------------------------
// a lifecycle over a fake clock and recording dependencies

function makeClock(start = 1_000) {
  let current = start;
  const timers: Array<{ at: number; callback: () => void; active: boolean }> = [];
  return {
    clock: {
      now: () => current,
      monotonicNow: () => current,
      schedule(delayMs: number, callback: () => void) {
        const timer = { at: current + delayMs, callback, active: true };
        timers.push(timer);
        return { dispose() { timer.active = false; } };
      },
    },
    advance(ms: number) {
      current += ms;
      for (const timer of [...timers]) {
        if (!timer.active || timer.at > current) continue;
        timer.active = false;
        timer.callback();
      }
    },
    now: () => current,
    timers,
  };
}

interface DependencyOptions {
  readonly displayServers?: Array<Record<string, unknown> | undefined>;
  readonly freshServers?: Array<Record<string, unknown> | undefined>;
  readonly freshRead?: (id: string) => unknown;
  readonly freshThrows?: boolean;
  readonly authStatuses?: Array<Record<string, unknown> | Error>;
  readonly validateTokens?: (() => Promise<unknown>) | Array<Record<string, unknown>>;
  readonly reloadThrows?: boolean;
  readonly authWatchTimeoutMs?: number;
}

function makeLifecycle(options: DependencyOptions = {}) {
  const calls: unknown[] = [];
  const events: Array<Record<string, unknown>> = [];
  const completions: unknown[] = [];
  const fake = makeClock();
  const displayServers = [...(options.displayServers ?? [])];
  const freshServers = [...(options.freshServers ?? [])];
  const authStatuses = [...(options.authStatuses ?? [])];
  let freshCalls = 0;
  const lifecycle = new SlateMcpAuthWatchLifecycle({
    backendMcpExec: {
      async checkAuthStatus(args: unknown) {
        calls.push(["checkAuthStatus", args]);
        const next = authStatuses.shift();
        if (next instanceof Error) throw next;
        return next ?? { isAvailable: true, requiresAuth: false, hasValidToken: false };
      },
      async validateTokens(args: unknown) {
        calls.push(["validateTokens", args]);
        return typeof options.validateTokens === "function" ? options.validateTokens() : options.validateTokens ?? [];
      },
    },
    authWatchPollIntervalMs: 1_000_000,
    authWatchTimeoutMs: options.authWatchTimeoutMs ?? 5_000,
    authWatchPollTimeoutMs: 100,
    async resolveDisplayServer(id: string, requestOptions?: unknown) {
      calls.push(["resolveDisplayServer", id, requestOptions]);
      if (requestOptions !== undefined && options.freshThrows === true) throw new Error("fresh read failed");
      if (requestOptions !== undefined && options.freshRead !== undefined) return options.freshRead(id) as never;
      if (requestOptions !== undefined && freshCalls < freshServers.length) {
        const fresh = freshServers[freshCalls];
        freshCalls += 1;
        return fresh as never;
      }
      return (displayServers.length > 1 ? displayServers.shift() : displayServers[0]) as never;
    },
    async reload() {
      calls.push(["reload"]);
      if (options.reloadThrows === true) throw new Error("reload failed");
    },
    onConnectorAuth(event: Record<string, unknown>) {
      events.push(event);
    },
    clock: fake.clock,
  });
  lifecycle.setAuthCompletionObserver((completion: unknown) => {
    completions.push(completion);
  });
  return { lifecycle, calls, events, completions, clock: fake };
}

const SERVER = {
  name: "Notes",
  disabledByTeamAdminPolicy: false,
  config: { url: "https://mcp.example.invalid/server" },
  serverIdentifier: "server-1",
  accounts: [{ accountKey: "account-1", serverIdentifier: "slot-1" }],
};
const LANDED = [{ serverUrl: "https://mcp.example.invalid/server", accountKey: "account-1", hasValidToken: true }];
const watch = (over: Record<string, unknown> = {}) => ({
  serverId: "7",
  accountKey: "account-1",
  serverName: "Notes",
  serverUrl: "https://mcp.example.invalid/server",
  requestingAgentId: "agent-1",
  forceReauth: false,
  ...over,
});

const startErrorOf = (event: Record<string, unknown> | undefined): unknown => {
  const error = event?.error as { code?: string; reason?: string } | undefined;
  return error === undefined ? undefined : { code: error.code, reason: error.reason };
};

/** Starts of a watch poll immediately; let that first tick settle before its state is read. */
const settle = async (): Promise<void> => {
  for (let round = 0; round < 12; round += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

// ---------------------------------------------------------------------------------------------
// the reasons and the start refusals

test("the two reason lists are what a caller branches on", () => {
  assert.deepEqual([...CONNECTOR_AUTH_START_REFUSAL_REASONS], [
    "not_configured",
    "admin_blocked",
    "stdio_unsupported",
    "invalid_auth_url",
    "no_auth_link",
    "unreachable",
  ]);
  assert.deepEqual([...CONNECTOR_AUTH_START_FAILURE_REASONS], ["probe_failed", "rpc_timeout"]);
});

test("a server that is not configured is answered and refused", async () => {
  const { lifecycle, events } = makeLifecycle();
  assert.deepEqual(await lifecycle.authenticateServer("7", "account-1"), { status: "not-configured", serverName: "7" });
  assert.deepEqual(events, [{
    phase: "flow_started",
    outcome: "failed",
    serverId: "7",
    serverName: undefined,
    error: events[0]!.error,
  }]);
  assert.deepEqual(startErrorOf(events[0]), { code: "SLATE-E0203", reason: "not_configured" });
});

test("a connector card click is reported before the flow is decided", async () => {
  const { lifecycle, events } = makeLifecycle({ displayServers: [SERVER] });
  await lifecycle.authenticateServer("7", "account-1", null, false, "connector_card");
  assert.deepEqual(events, [{ phase: "card_clicked", outcome: "ok", serverName: "Notes", serverId: "7" }]);
});

test("a server blocked by the team admin is confirmed, dropped and refused", async () => {
  const { lifecycle, calls, events, completions } = makeLifecycle({
    displayServers: [{ ...SERVER, disabledByTeamAdminPolicy: true }],
    freshServers: [undefined],
  });
  lifecycle.beginPendingAuthWatch(watch({ accountKey: "account-9", serverName: "Old" }) as never);
  const result = await lifecycle.authenticateServer("7", "account-1");
  assert.deepEqual(result, {
    status: "not-supported",
    serverName: "Notes",
    message: "This connector is disabled by your team admin's MCP policy, so it can't be authenticated.",
  });
  // The pending watch is dropped and announced as cancelled, then the catalog reloads and the refusal is reported.
  assert.deepEqual(completions, [{ serverId: "7", accountKey: "account-9", serverName: "Old", requestingAgentId: "agent-1", outcome: "cancelled" }]);
  assert.deepEqual(events.map((event) => [event.phase, event.outcome]), [
    ["token_stored", "cancelled"],
    ["flow_started", "failed"],
  ]);
  assert.deepEqual(startErrorOf(events[1]), { code: "SLATE-E0203", reason: "admin_blocked" });
  assert.equal(events[1]?.serverName, "Notes");
  assert.equal(calls.filter((call) => Array.isArray(call) && call[0] === "reload").length, 1);
});

test("a blocked server that a fresh read allows goes on to be checked", async () => {
  const { lifecycle, events } = makeLifecycle({
    displayServers: [{ ...SERVER, disabledByTeamAdminPolicy: true }],
    freshServers: [{ ...SERVER, disabledByTeamAdminPolicy: false }],
    authStatuses: [{ isAvailable: true, requiresAuth: false, hasValidToken: true }],
  });
  assert.deepEqual(await lifecycle.authenticateServer("7"), { status: "already-authenticated", serverName: "Notes" });
  assert.deepEqual(events, []);
});

test("a blocked server whose fresh read is still blocked stays blocked", async () => {
  const { lifecycle } = makeLifecycle({
    displayServers: [{ ...SERVER, disabledByTeamAdminPolicy: true }],
    freshServers: [{ ...SERVER, disabledByTeamAdminPolicy: true }],
  });
  assert.deepEqual(await lifecycle.authenticateServer("7"), {
    status: "not-supported",
    serverName: "Notes",
    message: "This connector is disabled by your team admin's MCP policy, so it can't be authenticated.",
  });
});

test("a blocked server whose fresh read fails is not treated as blocked", async () => {
  const { lifecycle } = makeLifecycle({
    displayServers: [{ ...SERVER, disabledByTeamAdminPolicy: true }],
    freshThrows: true,
    authStatuses: [{ isAvailable: true, requiresAuth: false, hasValidToken: true }],
  });
  assert.deepEqual(await lifecycle.authenticateServer("7"), { status: "already-authenticated", serverName: "Notes" });
});

test("a connector that runs on this computer is refused", async () => {
  const { lifecycle, events } = makeLifecycle({ displayServers: [{ ...SERVER, config: { command: "node", args: [] } }] });
  assert.deepEqual(await lifecycle.authenticateServer("7"), {
    status: "not-supported",
    serverName: "Notes",
    message: "This connector runs on Slate's computer and does not use browser sign-in. Configure credentials via its env settings instead.",
  });
  assert.deepEqual(startErrorOf(events[0]), { code: "SLATE-E0203", reason: "stdio_unsupported" });
});

test("a probe that ran out of time is reported as a timeout and then rethrown", async () => {
  const timeout = Object.assign(new Error("deadline"), { code: 4 });
  const { lifecycle, events, calls } = makeLifecycle({ displayServers: [SERVER], authStatuses: [timeout] });
  await assert.rejects(() => lifecycle.authenticateServer("7", "account-1", null, true), (error: unknown) => error === timeout);
  assert.deepEqual(startErrorOf(events[0]), { code: "SLATE-E0204", reason: "rpc_timeout" });
  assert.equal(events[0]?.outcome, "failed");
  // The probe is asked for the numeric id, the account, the loopback redirect and the caller's force.
  assert.deepEqual((calls.find((call) => Array.isArray(call) && call[0] === "checkAuthStatus") as unknown[])[1], {
    serverId: 7,
    accountKey: "account-1",
    oauthRedirectUri: MCP_OAUTH_LOOPBACK_CALLBACK_URL,
    forceReauth: true,
  });
});

test("a probe that failed for another reason is reported as a probe failure and then rethrown", async () => {
  const failure = new Error("boom");
  const { lifecycle, events } = makeLifecycle({ displayServers: [SERVER], authStatuses: [failure] });
  await assert.rejects(() => lifecycle.authenticateServer("7"), (error: unknown) => error === failure);
  assert.deepEqual(startErrorOf(events[0]), { code: "SLATE-E0204", reason: "probe_failed" });
  assert.equal(events[0]?.outcome, "failed");
});

test("a server that is already authorized says so and reloads", async () => {
  const { lifecycle, calls } = makeLifecycle({
    displayServers: [SERVER],
    authStatuses: [{ isAvailable: true, requiresAuth: true, hasValidToken: true }],
  });
  assert.deepEqual(await lifecycle.authenticateServer("7", "account-1"), { status: "already-authenticated", serverName: "Notes" });
  assert.equal(calls.filter((call) => Array.isArray(call) && call[0] === "reload").length, 1);
});

// ---------------------------------------------------------------------------------------------
// starting a sign-in and its watch

test("a sign-in is started with a watch and reported", async () => {
  const { lifecycle, events } = makeLifecycle({
    displayServers: [SERVER],
    authStatuses: [{ isAvailable: true, requiresAuth: true, hasValidToken: false, authUrl: "https://auth.example.invalid/start" }],
  });
  const result = await lifecycle.authenticateServer("7", "account-1", "agent-7");
  assert.deepEqual(result, { status: "started", authorizationUrl: "https://auth.example.invalid/start", serverName: "Notes" });
  assert.deepEqual(events, [{ phase: "flow_started", outcome: "ok", serverName: "Notes", serverId: "7", reauth: false }]);
  await settle();
  const [pending] = lifecycle.clearPendingAuthWatchesForServer("7");
  assert.deepEqual({ ...pending, poll: "poll" }, {
    serverId: "7",
    accountKey: "account-1",
    serverName: "Notes",
    serverIdentifier: "slot-1",
    serverUrl: "https://mcp.example.invalid/server",
    requestingAgentId: "agent-7",
    forceReauth: false,
    poll: "poll",
    suppressFirstPoll: false,
    expiresAtMs: 6_000,
    isPolling: false,
  });
});

test("a forced sign-in starts its watch with the first poll suppressed", async () => {
  const { lifecycle, events } = makeLifecycle({
    displayServers: [SERVER],
    authStatuses: [{ isAvailable: true, requiresAuth: true, hasValidToken: true, authUrl: "https://auth.example.invalid/start" }],
  });
  await lifecycle.authenticateServer("7", "account-1", null, true);
  await settle();
  assert.deepEqual(events, [{ phase: "flow_started", outcome: "ok", serverName: "Notes", serverId: "7", reauth: true }]);
  const [pending] = lifecycle.clearPendingAuthWatchesForServer("7");
  // The first automatic poll consumed the suppression without asking the backend.
  assert.equal(pending?.suppressFirstPoll, false);
  assert.equal((pending as unknown as { forceReauth?: boolean })?.forceReauth, true);
});

test("the watch identifier is the stored slot, then a provisional one, then nothing", async () => {
  const withSlot = makeLifecycle({
    displayServers: [SERVER],
    authStatuses: [{ isAvailable: true, requiresAuth: true, hasValidToken: false, authUrl: "https://auth.example.invalid/start" }],
  });
  await withSlot.lifecycle.authenticateServer("7", "account-1");
  await settle();
  assert.equal(withSlot.lifecycle.clearPendingAuthWatchesForServer("7")[0]?.serverIdentifier, "slot-1");

  const provisional = makeLifecycle({
    displayServers: [{ ...SERVER, serverIdentifier: "server-x", accounts: [] }],
    authStatuses: [{ isAvailable: true, requiresAuth: true, hasValidToken: false, authUrl: "https://auth.example.invalid/start" }],
  });
  await provisional.lifecycle.authenticateServer("7", "account-1");
  await settle();
  const [pending] = provisional.lifecycle.clearPendingAuthWatchesForServer("7");
  assert.equal(typeof pending?.serverIdentifier, "string");
  assert.equal(pending?.serverIdentifier?.includes("account-1"), true);

  const none = makeLifecycle({
    displayServers: [{ ...SERVER, serverIdentifier: undefined, accounts: [] }],
    authStatuses: [{ isAvailable: true, requiresAuth: true, hasValidToken: false, authUrl: "https://auth.example.invalid/start" }],
  });
  await none.lifecycle.authenticateServer("7", "account-1");
  await settle();
  assert.equal(none.lifecycle.clearPendingAuthWatchesForServer("7")[0]?.serverIdentifier, undefined);
});

test("an authorization URL that is not https is refused, and a forced attempt reloads", async () => {
  const { lifecycle, events, calls } = makeLifecycle({
    displayServers: [SERVER],
    authStatuses: [{ isAvailable: true, requiresAuth: true, hasValidToken: false, authUrl: "http://public.example.invalid/start" }],
  });
  assert.deepEqual(await lifecycle.authenticateServer("7", "account-1", null, true), {
    status: "not-supported",
    serverName: "Notes",
    message: "Only HTTPS authentication URLs are supported unless the MCP server is running on localhost.",
  });
  assert.deepEqual(startErrorOf(events[0]), { code: "SLATE-E0203", reason: "invalid_auth_url" });
  assert.equal(calls.filter((call) => Array.isArray(call) && call[0] === "reload").length, 1);
});

test("an authorization URL is validated against the server's own URL", async () => {
  const localhostAuth = makeLifecycle({
    displayServers: [{ ...SERVER, config: { url: "https://mcp.example.invalid/server" } }],
    authStatuses: [{ isAvailable: true, requiresAuth: true, hasValidToken: false, authUrl: "http://localhost:4321/callback" }],
  });
  const result = await localhostAuth.lifecycle.authenticateServer("7");
  assert.deepEqual(result, {
    status: "not-supported",
    serverName: "Notes",
    message: "Only HTTPS authentication URLs are supported unless the MCP server is running on localhost.",
  });
});

test("a forced start that fails drops the watch it was replacing", async () => {
  const { lifecycle, events } = makeLifecycle({
    displayServers: [SERVER],
    authStatuses: [{ isAvailable: true, requiresAuth: true, hasValidToken: false, authUrl: "http://public.example.invalid/start" }],
  });
  lifecycle.beginPendingAuthWatch(watch() as never);
  await settle();
  await lifecycle.authenticateServer("7", "account-1", null, true);
  assert.deepEqual(lifecycle.clearPendingAuthWatchesForServer("7"), []);
  assert.equal(events.some((event) => event.outcome === "cancelled"), true);
});

test("an unreachable connector answers with what it said, cleaned up", async () => {
  const detail = "  connection **refused** by the far side  ";
  const { lifecycle, events } = makeLifecycle({
    displayServers: [SERVER],
    authStatuses: [{ isAvailable: false, requiresAuth: false, hasValidToken: false, error: detail }],
  });
  const result = await lifecycle.authenticateServer("7");
  assert.deepEqual(result, { status: "unreachable", serverName: "Notes", message: stripMarkupAndBoundConnectorError(detail) });
  assert.deepEqual(startErrorOf(events[0]), { code: "SLATE-E0203", reason: "unreachable" });
});

test("an unreachable connector with no detail says so plainly", async () => {
  const { lifecycle } = makeLifecycle({
    displayServers: [SERVER],
    authStatuses: [{ isAvailable: false, requiresAuth: false, hasValidToken: false, error: "" }],
  });
  assert.deepEqual(await lifecycle.authenticateServer("7"), {
    status: "unreachable",
    serverName: "Notes",
    message: "The connector reported no details.",
  });
});

test("a connector that offered no sign-in link answers with its detail or a plain sentence", async () => {
  const withDetail = makeLifecycle({
    displayServers: [SERVER],
    authStatuses: [{ isAvailable: true, requiresAuth: true, hasValidToken: false, error: "  just no link  " }],
  });
  assert.deepEqual(await withDetail.lifecycle.authenticateServer("7"), {
    status: "not-supported",
    serverName: "Notes",
    message: stripMarkupAndBoundConnectorError("  just no link  "),
  });
  assert.deepEqual(startErrorOf(withDetail.events[0]), { code: "SLATE-E0203", reason: "no_auth_link" });

  const bare = makeLifecycle({
    displayServers: [SERVER],
    authStatuses: [{ isAvailable: true, requiresAuth: true, hasValidToken: false, error: "" }],
  });
  assert.deepEqual(await bare.lifecycle.authenticateServer("7"), {
    status: "not-supported",
    serverName: "Notes",
    message: "This connector did not provide a sign-in link.",
  });
});

// ---------------------------------------------------------------------------------------------
// polling a pending watch

test("a new watch polls immediately, and a forced sign-in's first poll is only a suppression", async () => {
  const plain = makeLifecycle({ displayServers: [SERVER], validateTokens: [] });
  plain.lifecycle.beginPendingAuthWatch(watch() as never);
  await settle();
  assert.equal(plain.calls.filter((call) => Array.isArray(call) && call[0] === "validateTokens").length, 1);

  const forced = makeLifecycle({ displayServers: [SERVER], validateTokens: [] });
  forced.lifecycle.beginPendingAuthWatch(watch({ forceReauth: true }) as never);
  await settle();
  assert.equal(forced.calls.filter((call) => Array.isArray(call) && call[0] === "validateTokens").length, 0);
  // The next poll is a real one; the suppression is only ever the first tick.
  await forced.lifecycle.pollPendingAuthWatch(authWatchKey("7", "account-1"));
  assert.equal(forced.calls.filter((call) => Array.isArray(call) && call[0] === "validateTokens").length, 1);
  const [pending] = forced.lifecycle.clearPendingAuthWatchesForServer("7");
  assert.equal(pending?.suppressFirstPoll, false);
});

test("a watch that outlived its window is dropped and reported as abandoned", async () => {
  const { lifecycle, events, clock } = makeLifecycle({ displayServers: [SERVER], validateTokens: [] });
  lifecycle.beginPendingAuthWatch(watch() as never);
  await settle();
  clock.advance(6_000);
  await lifecycle.pollPendingAuthWatch(authWatchKey("7", "account-1"));
  assert.deepEqual(events, [{
    phase: "token_stored",
    outcome: "timeout",
    serverName: "Notes",
    serverId: "7",
    error: events[0]!.error,
  }]);
  const error = events[0]?.error as { code?: string };
  assert.equal(error.code, "SLATE-E0206");
  assert.deepEqual(lifecycle.clearPendingAuthWatchesForServer("7"), []);
});

test("a landed token completes the watch and reloads", async () => {
  const { lifecycle, events, completions, calls } = makeLifecycle({
    displayServers: [SERVER],
    freshServers: [SERVER],
    validateTokens: LANDED,
  });
  lifecycle.beginPendingAuthWatch(watch({ serverIdentifier: "slot-1" }) as never);
  await settle();
  assert.deepEqual(completions, [{
    serverId: "7",
    accountKey: "account-1",
    serverName: "Notes",
    serverIdentifier: "slot-1",
    requestingAgentId: "agent-1",
  }]);
  assert.deepEqual(events, [{ phase: "token_stored", outcome: "ok", serverName: "Notes", serverId: "7" }]);
  assert.deepEqual(lifecycle.clearPendingAuthWatchesForServer("7"), []);
  assert.equal(calls.filter((call) => Array.isArray(call) && call[0] === "reload").length, 1);
});

test("a token that has not landed leaves the watch in place", async () => {
  const { lifecycle, events, calls } = makeLifecycle({
    displayServers: [SERVER],
    validateTokens: [{ serverUrl: "https://mcp.example.invalid/server", accountKey: "account-1", hasValidToken: false }],
  });
  lifecycle.beginPendingAuthWatch(watch() as never);
  await settle();
  assert.deepEqual(events, []);
  assert.equal(calls.some((call) => Array.isArray(call) && call[0] === "reload"), false);
  assert.equal(lifecycle.clearPendingAuthWatchesForServer("7").length, 1);
});

test("a landed token for a server that is gone cancels the watch", async () => {
  const { lifecycle, events, completions, calls } = makeLifecycle({
    displayServers: [SERVER],
    freshServers: [undefined],
    validateTokens: LANDED,
  });
  lifecycle.beginPendingAuthWatch(watch() as never);
  await settle();
  assert.deepEqual(events, [{ phase: "token_stored", outcome: "cancelled", serverName: "Notes", serverId: "7" }]);
  assert.deepEqual(completions, [{ serverId: "7", accountKey: "account-1", serverName: "Notes", requestingAgentId: "agent-1", outcome: "cancelled" }]);
  assert.equal(calls.filter((call) => Array.isArray(call) && call[0] === "reload").length, 1);
  assert.deepEqual(lifecycle.clearPendingAuthWatchesForServer("7"), []);
});

test("a landed token whose fresh read fails still completes the watch", async () => {
  const { lifecycle, events } = makeLifecycle({ displayServers: [SERVER], freshThrows: true, validateTokens: LANDED });
  lifecycle.beginPendingAuthWatch(watch() as never);
  await settle();
  assert.deepEqual(events, [{ phase: "token_stored", outcome: "ok", serverName: "Notes", serverId: "7" }]);
  assert.deepEqual(lifecycle.clearPendingAuthWatchesForServer("7"), []);
});

test("a poll for a watch that is already polling is ignored", async () => {
  let release: (() => void) | undefined;
  const { lifecycle, calls } = makeLifecycle({
    displayServers: [SERVER],
    validateTokens: () => new Promise((resolve) => {
      release = () => resolve(LANDED);
    }),
  });
  lifecycle.beginPendingAuthWatch(watch() as never);
  await settle();
  await lifecycle.pollPendingAuthWatch(authWatchKey("7", "account-1"));
  release?.();
  await settle();
  assert.equal(calls.filter((call) => Array.isArray(call) && call[0] === "validateTokens").length, 1);
});

test("a poll whose watch was cleared while the token was checked does nothing", async () => {
  const { lifecycle, events } = makeLifecycle({
    displayServers: [SERVER],
    validateTokens: () => new Promise((resolve) => {
      lifecycle.clearPendingAuthWatch("7", "account-1");
      resolve(LANDED);
    }),
  });
  lifecycle.beginPendingAuthWatch(watch() as never);
  await settle();
  assert.deepEqual(events, []);
});

// ---------------------------------------------------------------------------------------------
// clearing and announcing

test("watches are found, dropped and announced by key and by server", () => {
  const { lifecycle, events, completions } = makeLifecycle({ displayServers: [SERVER] });
  lifecycle.beginPendingAuthWatch(watch({ accountKey: "account-1", serverName: "One" }) as never);
  lifecycle.beginPendingAuthWatch(watch({ accountKey: "account-2", serverName: "Two", requestingAgentId: null }) as never);
  lifecycle.beginPendingAuthWatch(watch({ serverId: "8", accountKey: "account-1", serverName: "Three" }) as never);

  assert.equal(lifecycle.clearPendingAuthWatch("7", "account-1")?.serverName, "One");
  assert.equal(lifecycle.clearPendingAuthWatch("7", "account-1"), null);
  assert.equal(lifecycle.noteAuthCompletedElsewhere("7", "account-2"), null);
  assert.equal(lifecycle.noteAuthCompletedElsewhere("", "account-2"), null);

  const cancelled = lifecycle.clearPendingAuthWatchCancelled("8", "account-1");
  assert.equal(cancelled?.serverName, "Three");
  assert.deepEqual(events, [{ phase: "token_stored", outcome: "cancelled", serverName: "Three", serverId: "8" }]);

  lifecycle.beginPendingAuthWatch(watch({ serverId: "9", accountKey: "account-1", serverName: "Four", serverIdentifier: "slot-4" }) as never);
  lifecycle.notifyWatchCancelled(lifecycle.clearPendingAuthWatch("9", "account-1")!);
  assert.deepEqual(completions.at(-1), { serverId: "9", accountKey: "account-1", serverName: "Four", serverIdentifier: "slot-4", requestingAgentId: "agent-1", outcome: "cancelled" });
});

test("all watches for one server can be dropped, and so can all of them", () => {
  const { lifecycle, events } = makeLifecycle({ displayServers: [SERVER] });
  lifecycle.beginPendingAuthWatch(watch({ accountKey: "account-1" }) as never);
  lifecycle.beginPendingAuthWatch(watch({ accountKey: "account-2" }) as never);
  lifecycle.beginPendingAuthWatch(watch({ serverId: "8", accountKey: "account-1" }) as never);
  const cleared = lifecycle.clearPendingAuthWatchesForServer("7");
  assert.deepEqual(cleared.map((pending) => pending.accountKey), ["account-1", "account-2"]);
  assert.deepEqual(events.map((event) => event.outcome), ["cancelled", "cancelled"]);

  lifecycle.beginPendingAuthWatch(watch({ accountKey: "account-3" }) as never);
  lifecycle.clearAllPendingAuthWatches();
  assert.deepEqual(lifecycle.clearPendingAuthWatchesForServer("7"), []);

  lifecycle.beginPendingAuthWatch(watch({ accountKey: "account-4" }) as never);
  const beforeCancelled = events.length;
  lifecycle.clearAllPendingAuthWatchesCancelled();
  assert.deepEqual(lifecycle.clearPendingAuthWatchesForServer("7"), []);
  assert.equal(events.length, beforeCancelled + 1);
  assert.equal(events.at(-1)?.outcome, "cancelled");
});

test("a watch begun for an existing flow keeps the agent the first flow was for", async () => {
  const { lifecycle, events } = makeLifecycle({ displayServers: [SERVER], validateTokens: [] });
  lifecycle.beginPendingAuthWatch(watch({ requestingAgentId: "agent-1" }) as never);
  await settle();
  lifecycle.beginPendingAuthWatch(watch({ requestingAgentId: null }) as never);
  await settle();
  assert.equal(events.filter((event) => event.outcome === "cancelled").length, 1);
  const [pending] = lifecycle.clearPendingAuthWatchesForServer("7");
  assert.equal(pending?.requestingAgentId, "agent-1");
});

test("clearing a watch disposes its poller", async () => {
  const { lifecycle, calls, clock } = makeLifecycle({ displayServers: [SERVER], validateTokens: [], authWatchTimeoutMs: 10_000_000 });
  lifecycle.beginPendingAuthWatch(watch() as never);
  await settle();
  const scheduled = clock.timers.filter((timer) => timer.active);
  assert.equal(scheduled.length > 0, true);
  lifecycle.clearPendingAuthWatch("7", "account-1");
  // Every timer the cleared watch had scheduled is now disposed.
  assert.deepEqual(scheduled.filter((timer) => timer.active), []);
  lifecycle.beginPendingAuthWatch(watch() as never);
  await settle();
  const before = calls.filter((call) => Array.isArray(call) && call[0] === "validateTokens").length;
  clock.advance(1_000_000);
  await settle();
  // Only the watch that is still alive gets the extra tick.
  assert.equal(calls.filter((call) => Array.isArray(call) && call[0] === "validateTokens").length, before + 1);
});

test("a watch with a blank server url never asks the backend", async () => {
  const { lifecycle, calls } = makeLifecycle({ displayServers: [SERVER], validateTokens: [] });
  lifecycle.beginPendingAuthWatch(watch({ serverUrl: "   " }) as never);
  await settle();
  assert.equal(calls.filter((call) => Array.isArray(call) && call[0] === "validateTokens").length, 0);
  assert.equal(lifecycle.clearPendingAuthWatchesForServer("7").length, 1);
});

test("a token for another account does not complete the watch", async () => {
  const { lifecycle, completions } = makeLifecycle({
    displayServers: [SERVER],
    freshServers: [SERVER],
    validateTokens: [{ serverUrl: "https://mcp.example.invalid/server", accountKey: "account-2", hasValidToken: true }],
  });
  lifecycle.beginPendingAuthWatch(watch() as never);
  await settle();
  assert.deepEqual(completions, []);
  assert.equal(lifecycle.clearPendingAuthWatchesForServer("7").length, 1);
});

test("a watch expires exactly when its window is up", async () => {
  const { lifecycle, events, clock } = makeLifecycle({ displayServers: [SERVER], validateTokens: [] });
  lifecycle.beginPendingAuthWatch(watch() as never);
  await settle();
  clock.advance(5_000);
  await lifecycle.pollPendingAuthWatch(authWatchKey("7", "account-1"));
  assert.equal(events.at(-1)?.outcome, "timeout");
});

test("a watch cleared while its fresh read is in flight is not completed", async () => {
  const { lifecycle, events, completions, calls } = makeLifecycle({
    displayServers: [SERVER],
    validateTokens: LANDED,
    freshRead: () => {
      lifecycle.clearPendingAuthWatch("7", "account-1");
      return SERVER;
    },
  });
  lifecycle.beginPendingAuthWatch(watch() as never);
  await settle();
  assert.deepEqual(events, []);
  assert.deepEqual(completions, []);
  assert.equal(calls.some((call) => Array.isArray(call) && call[0] === "reload"), false);
});

test("a token check that fails does not escape the poll", async () => {
  const { lifecycle, events } = makeLifecycle({
    displayServers: [SERVER],
    validateTokens: () => {
      throw new Error("the backend is gone");
    },
  });
  lifecycle.beginPendingAuthWatch(watch() as never);
  await settle();
  await assert.doesNotReject(() => lifecycle.pollPendingAuthWatch(authWatchKey("7", "account-1")));
  assert.deepEqual(events, []);
});

test("a completion observer that throws does not reach the caller", () => {
  const { lifecycle, events } = makeLifecycle({ displayServers: [SERVER] });
  lifecycle.setAuthCompletionObserver(() => {
    throw new Error("observer gone");
  });
  lifecycle.beginPendingAuthWatch(watch() as never);
  const pending = lifecycle.clearPendingAuthWatch("7", "account-1")!;
  assert.doesNotThrow(() => lifecycle.notifyWatchCancelled(pending));
  assert.equal(events.length, 0);
});

test("a poll that outlives its own deadline leaves the watch for the next one", async () => {
  const { lifecycle, events, clock } = makeLifecycle({
    displayServers: [SERVER],
    validateTokens: () => new Promise(() => {}),
  });
  lifecycle.beginPendingAuthWatch(watch() as never);
  await settle();
  clock.advance(100);
  await settle();
  assert.deepEqual(events, []);
  const [pending] = lifecycle.clearPendingAuthWatchesForServer("7");
  assert.equal(pending?.isPolling, false);
});

test("a reload that fails while reporting a blocked server is swallowed", async () => {
  const { lifecycle } = makeLifecycle({
    displayServers: [{ ...SERVER, disabledByTeamAdminPolicy: true }],
    freshServers: [undefined],
    reloadThrows: true,
  });
  assert.deepEqual(await lifecycle.authenticateServer("7"), {
    status: "not-supported",
    serverName: "Notes",
    message: "This connector is disabled by your team admin's MCP policy, so it can't be authenticated.",
  });
});