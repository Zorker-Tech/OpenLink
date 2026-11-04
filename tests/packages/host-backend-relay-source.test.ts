import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_REGISTER_INTERVAL_MS,
  DEGRADED_REGISTER_INTERVAL_MS,
  ERROR_BACKOFF_MS,
  SlateBackendRelayError,
  createBackendRelaySources,
  mapRelayWireEvent,
  relaySubscriptionRequestOf,
} from "../../source/host/automations/backend-relay-source.ts";
import { GITHUB_EVENT_KINDS, TRIGGER_ANY_SCOPE, type GithubTrigger, type SlackTrigger } from "../../source/shared/automations.ts";
import type { PollingPolicy } from "../../source/host/extensions/scheduling.ts";

interface RelayReply {
  readonly ok?: boolean;
  readonly status?: number;
  readonly body?: Record<string, unknown>;
}

interface RelayRequest {
  readonly url: URL;
  readonly init: RequestInit;
  readonly body: Record<string, unknown>;
}

function relayWorld(options: {
  readonly reply?: (request: RelayRequest, index: number) => RelayReply | Error | Promise<RelayReply | Error>;
  readonly isConnected?: () => boolean;
  readonly isSafetyPollEnabled?: () => boolean;
} = {}) {
  const requests: RelayRequest[] = [];
  let tick: (() => Promise<void>) | undefined;
  let pollingStarts = 0;
  let pollingDisposals = 0;
  const polling: PollingPolicy = {
    name: "test-relay-poll",
    start(next) {
      pollingStarts += 1;
      tick = next;
      let active = true;
      return { dispose() { if (active) { active = false; pollingDisposals += 1; } } };
    },
  };
  const sources = createBackendRelaySources({
    getAccessToken: async ({ backendUrl }) => {
      assert.equal(backendUrl, "https://slate.example/api/");
      return "relay-token";
    },
    getBackendUrl: () => "https://slate.example/api/",
    polling,
    fetchImpl: async (input, init = {}) => {
      const url = new URL(String(input));
      const body = JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>;
      const request = { url, init, body };
      requests.push(request);
      const reply = await options.reply?.(request, requests.length - 1) ?? {
        ok: true,
        status: 200,
        body: url.pathname.endsWith("/poll") ? { events: [] } : {},
      };
      if (reply instanceof Error) throw reply;
      return {
        ok: reply.ok ?? true,
        status: reply.status ?? 200,
        json: async () => reply.body ?? {},
      } as Response;
    },
    ...(options.isConnected === undefined ? {} : { isNotifyConnected: options.isConnected }),
    ...(options.isSafetyPollEnabled === undefined ? {} : { isNotifySafetyPollEnabled: options.isSafetyPollEnabled }),
  });

  return {
    sources,
    requests,
    pollingStarts: () => pollingStarts,
    pollingDisposals: () => pollingDisposals,
    runTick: async () => { assert.ok(tick, "a source must start before the polling tick can run"); await tick(); },
  };
}

function freezeTime(initial: number) {
  const original = Date.now;
  let now = initial;
  Date.now = () => now;
  return {
    set(value: number) { now = value; },
    restore() { Date.now = original; },
  };
}

const slack = (channel: string): SlackTrigger => ({ type: "slack", channel, match: { kind: "message" } });
const github = (repo: string, events: string[]): GithubTrigger => ({ type: "github", repo, events });

describe("the subscription request for backend relay listeners", () => {
  it("sorts and deduplicates scopes and event kinds", () => {
    assert.deepEqual(relaySubscriptionRequestOf(
      [slack("zeta"), slack(TRIGGER_ANY_SCOPE), slack("alpha"), slack("alpha")],
      [github("Team/Repo", ["pr-merged", "pr-opened"]), github("team/repo", ["pr-opened", "ci-failed"])],
    ), {
      slackChannels: ["*", "alpha", "zeta"],
      githubRepos: ["team/repo"],
      githubKinds: ["ci-failed", "pr-merged", "pr-opened"],
    });
  });

  it("keeps the full-repository scope and allows an empty subscription", () => {
    assert.deepEqual(relaySubscriptionRequestOf([slack(TRIGGER_ANY_SCOPE)], []), {
      slackChannels: ["*"], githubRepos: [], githubKinds: [],
    });
    assert.deepEqual(relaySubscriptionRequestOf([], []), {
      slackChannels: [], githubRepos: [], githubKinds: [],
    });
  });
});

describe("mapping the relay's event into a Slate listener event", () => {
  it("normalizes a message channel, sender, optional thread fields, and strict mention flag", () => {
    assert.deepEqual(mapRelayWireEvent({
      source: "slack", channelName: "design", channelId: "C-1", senderSlackUserId: "U-2",
      text: "hello", isMention: 1, ts: "10.2", threadTs: "10.0", timestampMs: 42,
    }), {
      source: "slack", channel: "#design", sender: "@U-2", text: "hello", isMention: false,
      ts: "10.2", threadTs: "10.0", timestampMs: 42,
    });
    const time = freezeTime(987);
    try {
      assert.deepEqual(mapRelayWireEvent({ source: "slack", channelId: "#general" }), {
      source: "slack", channel: "#general", sender: "someone", text: "", isMention: false,
        timestampMs: 987,
      });
    } finally {
      time.restore();
    }
  });

  it("normalizes reactions while rejecting missing channel names and empty emoji", () => {
    assert.deepEqual(mapRelayWireEvent({
      source: "slack", kind: "reaction", channelId: "general", reactionEmoji: ":wave:",
      isSelf: true, text: "note", ts: "3", threadTs: "2", timestampMs: 55,
    }), {
      source: "slack", channel: "general", sender: "someone", text: "note", isMention: false,
      isSelf: true, reactionEmoji: ":wave:", ts: "3", threadTs: "2", timestampMs: 55,
    });
    assert.equal(mapRelayWireEvent({ source: "slack", channelName: "", channelId: "" }), null);
    assert.equal(mapRelayWireEvent({ source: "slack", kind: "reaction", channelName: "general", reactionEmoji: "" }), null);
  });

  it("accepts only declared GitHub event kinds and preserves optional pull-request details", () => {
    assert.deepEqual(mapRelayWireEvent({
      source: "github", repo: "team/repo", kind: "pr-opened", title: "Review", actor: "A",
      url: "https://example.test/pr/1", detail: "opened", prOwner: "team", branch: "feature", timestampMs: 12,
    }), {
      source: "github", repo: "team/repo", kind: "pr-opened", title: "Review", actor: "A",
      url: "https://example.test/pr/1", detail: "opened", prOwner: "team", branch: "feature", timestampMs: 12,
    });
    assert.equal(GITHUB_EVENT_KINDS.includes("pr-opened"), true);
    assert.equal(mapRelayWireEvent({ source: "github", repo: "team/repo", kind: "unknown" }), null);
    assert.equal(mapRelayWireEvent({ source: "github", repo: "", kind: "pr-opened" }), null);
    assert.deepEqual(mapRelayWireEvent({ source: "other", repo: "team/repo", kind: "pr-opened" } as never), {
      source: "github", repo: "team/repo", kind: "pr-opened", title: "", actor: "someone",
      timestampMs: Date.now(),
    });
  });
});

describe("the polling sources a listener hub subscribes to", () => {
  it("starts one shared timer, exposes connecting state, and stops only when both sources are idle", async () => {
    const world = relayWorld();
    assert.deepEqual(world.sources.slack.getStatus(), { state: "idle" });
    await world.sources.slack.start(() => true);
    await world.sources.github.start(() => true);
    assert.deepEqual(world.sources.slack.getStatus(), { state: "connecting" });
    assert.deepEqual(world.sources.github.getStatus(), { state: "connecting" });
    assert.equal(world.pollingStarts(), 1);

    await world.sources.slack.stop();
    assert.equal(world.pollingDisposals(), 0);
    await world.sources.github.stop();
    assert.equal(world.pollingDisposals(), 1);
  });

  it("registers and polls with bearer authentication and typed JSON bodies", async () => {
    const world = relayWorld({ reply: (request) => ({
      ok: true, status: 200,
      body: request.url.pathname.endsWith("subscriptions")
        ? { slack: { status: "connected" } }
        : { events: [] },
    }) });
    await world.sources.slack.start(() => true);
    world.sources.slack.setListeners([slack("general")]);
    await world.runTick();

    assert.deepEqual(world.requests.map(({ url }) => url.pathname), [
      "/slate/listener-subscriptions", "/slate/listener-events/poll",
    ]);
    assert.deepEqual(world.requests.map(({ body }) => body), [
      { slackChannels: ["general"], githubRepos: [], githubKinds: [] },
      { ackIds: [] },
    ]);
    for (const request of world.requests) {
      assert.equal(request.init.method, "POST");
      assert.equal(new Headers(request.init.headers).get("authorization"), "Bearer relay-token");
      assert.equal(new Headers(request.init.headers).get("content-type"), "application/json");
    }
  });

  it("keeps identical registrations until their freshness interval expires", async () => {
    const time = freezeTime(1_000_000);
    try {
      const world = relayWorld();
      await world.sources.slack.start(() => true);
      world.sources.slack.setListeners([slack("general")]);
      await world.runTick();
      assert.equal(world.requests.length, 2);

      time.set(1_000_000 + DEFAULT_REGISTER_INTERVAL_MS);
      await world.runTick();
      assert.equal(world.requests.length, 3, "the registration remains fresh at the inclusive boundary");

      time.set(1_000_001 + DEFAULT_REGISTER_INTERVAL_MS);
      await world.runTick();
      assert.equal(world.requests.length, 5, "the next tick refreshes the registration");
    } finally {
      time.restore();
    }
  });

  it("registers a changed listener scope immediately", async () => {
    const world = relayWorld();
    await world.sources.github.start(() => true);
    world.sources.github.setListeners([github("team/one", ["pr-opened"])]);
    await world.runTick();
    world.sources.github.setListeners([github("team/two", ["ci-failed"])]);
    await world.runTick();

    assert.deepEqual(world.requests.filter(({ url }) => url.pathname.endsWith("subscriptions")).map(({ body }) => body), [
      { slackChannels: [], githubRepos: ["team/one"], githubKinds: ["pr-opened"] },
      { slackChannels: [], githubRepos: ["team/two"], githubKinds: ["ci-failed"] },
    ]);
  });

  it("reports an unlinked Slack source and fully failed GitHub subscriptions", async () => {
    const world = relayWorld({ reply: (request) => ({
      body: request.url.pathname.endsWith("subscriptions")
        ? { slack: { status: "not-linked" }, github: { status: "connected", repos: [{ repo: "team/repo", isSubscribed: false }] } }
        : { events: [] },
    }) });
    await world.sources.slack.start(() => true);
    await world.sources.github.start(() => true);
    world.sources.slack.setListeners([slack("general")]);
    world.sources.github.setListeners([github("team/repo", ["pr-opened"])]);
    await world.runTick();

    assert.deepEqual(world.sources.slack.getStatus(), {
      state: "error", detail: "Slack isn't connected to your Slate account. Connect it to start listening.",
    });
    assert.deepEqual(world.sources.github.getStatus(), {
      state: "error", detail: "Can't watch team/repo.",
    });
  });

  it("reports a GitHub account that is not connected", async () => {
    const world = relayWorld({ reply: (request) => ({
      body: request.url.pathname.endsWith("subscriptions")
        ? { github: { status: "not-connected" } }
        : { events: [] },
    }) });
    await world.sources.github.start(() => true);
    world.sources.github.setListeners([github("team/repo", ["pr-opened"])]);
    await world.runTick();

    assert.deepEqual(world.sources.github.getStatus(), {
      state: "error", detail: "GitHub isn't connected to your Slate account. Connect it to start listening.",
    });
  });

  it("reports scope issues while retaining a partially subscribed GitHub source", async () => {
    const world = relayWorld({ reply: (request) => ({
      body: request.url.pathname.endsWith("subscriptions")
        ? {
          slack: { status: "connected", teams: [{ channels: [{ input: "#private", isBotMember: false }], unresolvedChannels: ["#missing"] }] },
          github: { repos: [{ repo: "team/ok", isSubscribed: true }, { repo: "team/no", isSubscribed: false, detail: "missing permission" }] },
        }
        : { events: [] },
    }) });
    await world.sources.slack.start(() => true);
    await world.sources.github.start(() => true);
    world.sources.slack.setListeners([slack("#private")]);
    world.sources.github.setListeners([github("team/ok", ["pr-opened"]), github("team/no", ["pr-opened"])]);
    await world.runTick();

    const slackStatus = world.sources.slack.getStatus();
    assert.equal(slackStatus.state, "listening");
    assert.deepEqual(slackStatus.scopeIssues, [
      { scope: "#private", kind: "bot-not-in-channel" },
      { scope: "#missing", kind: "not-found" },
    ]);
    assert.match(slackStatus.detail ?? "", /Invite @Slate to #private in Slack/);
    assert.deepEqual(world.sources.github.getStatus(), { state: "listening", detail: "missing permission" });
  });

  it("retries unaccepted events, acknowledges accepted events, and suppresses acknowledged duplicates", async () => {
    let accept = false;
    let deliveries = 0;
    const wire = { id: "event-1", source: "github", repo: "team/repo", kind: "pr-opened", title: "change" };
    const world = relayWorld({ reply: (request) => ({ body: request.url.pathname.endsWith("subscriptions")
      ? { github: { status: "connected" } }
      : { events: [{ ...wire }] } }) });
    await world.sources.github.start(() => { deliveries += 1; return accept; });
    world.sources.github.setListeners([github("team/repo", ["pr-opened"])]);

    await world.runTick();
    assert.equal(deliveries, 1);
    accept = true;
    await world.runTick();
    assert.equal(deliveries, 2);
    assert.deepEqual(world.requests.at(-1)?.body, { ackIds: [] });
    await world.runTick();
    assert.equal(deliveries, 2, "an event awaiting its ack is not delivered twice");
    assert.deepEqual(world.requests.at(-1)?.body, { ackIds: ["event-1"] });
  });

  it("acknowledges relay events that cannot be mapped to a listener event", async () => {
    let delivered = 0;
    let pollCount = 0;
    const world = relayWorld({ reply: (request) => {
      if (request.url.pathname.endsWith("subscriptions")) return { body: { slack: { status: "connected" } } };
      pollCount += 1;
      return { body: { events: pollCount === 1 ? [{ id: "bad-event", source: "slack", channelId: "" }] : [] } };
    } });
    await world.sources.slack.start(() => { delivered += 1; return true; });
    world.sources.slack.setListeners([slack("general")]);
    await world.runTick();
    await world.runTick();

    assert.equal(delivered, 0);
    assert.deepEqual(world.requests.at(-1)?.body, { ackIds: ["bad-event"] });
  });

  it("registers while disconnected but polls only for safety or outstanding acknowledgements", async () => {
    let connected = false;
    let polls = 0;
    const world = relayWorld({
      isConnected: () => connected,
      isSafetyPollEnabled: () => false,
      reply: (request) => {
        if (request.url.pathname.endsWith("subscriptions")) return { body: { slack: { status: "connected" } } };
        polls += 1;
        return { body: { events: polls === 1 ? [{ id: "event-a", source: "slack", channelName: "general", text: "x" }] : [] } };
      },
    });
    await world.sources.slack.start(() => true);
    world.sources.slack.setListeners([slack("general")]);
    await world.runTick();
    assert.equal(world.requests.length, 1, "no poll is issued while both notify paths are down");

    connected = true;
    await world.runTick();
    assert.equal(polls, 1);
    connected = false;
    await world.runTick();
    assert.deepEqual(world.requests.at(-1)?.body, { ackIds: ["event-a"] });
    assert.equal(polls, 2, "an outstanding acknowledgement is still flushed while notifications are disconnected");
    await world.runTick();
    assert.equal(polls, 2, "once the acknowledgement clears, offline safety polling can stop");
  });

  it("keeps a tick single-flight while a relay request is unresolved", async () => {
    let release!: (reply: RelayReply) => void;
    const pending = new Promise<RelayReply>((resolve) => { release = resolve; });
    let requestCount = 0;
    const world = relayWorld({ reply: async () => { requestCount += 1; return pending; } });
    await world.sources.slack.start(() => true);
    world.sources.slack.setListeners([slack("general")]);

    const first = world.runTick();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await world.runTick();
    assert.equal(requestCount, 1);
    release({ body: { slack: { status: "connected" } } });
    await first;
    assert.equal(requestCount, 2, "the in-flight tick also completes its poll request");
  });

  it("backs off after a failed request and reports the service error only for active listeners", async () => {
    const time = freezeTime(5_000);
    try {
      let failPoll = true;
      const world = relayWorld({ reply: (request) => {
        if (request.url.pathname.endsWith("/poll") && failPoll) return { ok: false, status: 503 };
        return { body: request.url.pathname.endsWith("subscriptions") ? { slack: { status: "connected" } } : { events: [] } };
      } });
      await world.sources.slack.start(() => true);
      world.sources.slack.setListeners([slack("general")]);
      await world.runTick();
      assert.deepEqual(world.sources.slack.getStatus(), { state: "error", detail: "relay /slate/listener-events/poll returned 503" });
      assert.equal(world.requests.length, 2);

      time.set(5_000 + ERROR_BACKOFF_MS - 1);
      await world.runTick();
      assert.equal(world.requests.length, 2);

      failPoll = false;
      time.set(5_000 + ERROR_BACKOFF_MS);
      await world.runTick();
      assert.equal(world.requests.length, 4, "the next tick retries registration and polling");
      assert.deepEqual(world.sources.slack.getStatus(), { state: "listening" });
    } finally {
      time.restore();
    }
  });

  it("retries degraded registrations on the bounded backoff schedule", async () => {
    const time = freezeTime(10_000);
    try {
      let registrationCount = 0;
      const world = relayWorld({ reply: (request) => {
        if (!request.url.pathname.endsWith("subscriptions")) return { body: { events: [] } };
        registrationCount += 1;
        return { body: { slack: { status: "not-linked" } } };
      } });
      await world.sources.slack.start(() => true);
      world.sources.slack.setListeners([slack("general")]);
      await world.runTick();
      time.set(10_000 + DEGRADED_REGISTER_INTERVAL_MS);
      await world.runTick();
      assert.equal(registrationCount, 1, "degraded refresh remains fresh on its inclusive boundary");
      time.set(10_001 + DEGRADED_REGISTER_INTERVAL_MS);
      await world.runTick();
      assert.equal(registrationCount, 2);
    } finally {
      time.restore();
    }
  });

  it("uses a named relay error when the service rejects a request", async () => {
    const world = relayWorld({ reply: () => ({ ok: false, status: 401 }) });
    await world.sources.slack.start(() => true);
    world.sources.slack.setListeners([slack("general")]);
    await world.runTick();

    assert.equal(world.sources.slack.getStatus().state, "error");
    assert.equal(world.sources.slack.getStatus().detail, "relay /slate/listener-subscriptions returned 401");
    assert.equal(SlateBackendRelayError.prototype instanceof Error, true);
  });
});
