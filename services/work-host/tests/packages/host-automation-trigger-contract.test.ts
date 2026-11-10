/**
 * What stored automation triggers accept, how listeners match an event and what context a trigger sends to a model.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  TRIGGER_MAX_ALLOWLIST_LOGIN_LENGTH,
  TRIGGER_MAX_ALLOWLIST_LOGINS,
  TRIGGER_MAX_BRANCH_LENGTH,
  TRIGGER_MAX_CHANNEL_LENGTH,
  TRIGGER_MAX_FILTER_IDS,
  TRIGGER_MAX_ID_LENGTH,
  TRIGGER_MAX_KEYWORD_LENGTH,
  TRIGGER_MAX_REPO_LENGTH,
  buildTriggerEventContextBlock,
  describeTriggerEvent,
  githubListenerMatches,
  listenerMatchesEvent,
  parseStoredTrigger,
  serializeStoredTrigger,
  slackListenerMatches,
  slackScopeMatches,
  triggerIdentity,
  triggerMatchesEvent,
} from "../../source/host/automations/automation-trigger.ts";
import {
  GITHUB_EVENT_KINDS,
  REACTION_EMOJI_PATTERN,
  TRIGGER_ANY_SCOPE,
  TRIGGER_MAX_GROUP_LISTENERS,
  TRIGGER_MAX_REACTION_EMOJI,
  normalizeReactionEmoji,
} from "../../source/shared/automations.ts";

describe("normalizing a stored trigger", () => {
  it("bounds ids, list lengths, names and multiline text before they reach a listener", () => {
    const trigger = parseStoredTrigger({
      type: "microsoftTeams",
      tenantId: `  ${"t".repeat(TRIGGER_MAX_ID_LENGTH + 20)}  `,
      teamId: " ",
      teamIds: Array.from({ length: TRIGGER_MAX_FILTER_IDS + 5 }, (_, index) => `team-${index}`),
      channelIds: ["channel-1", "channel-1", "", "channel-2"],
      messageContains: `  deploy\n${"x".repeat(TRIGGER_MAX_KEYWORD_LENGTH + 10)}  `,
      messageContainsIsRegex: true,
      blockUnauthenticatedTeamsUsers: true,
    });
    assert.equal(trigger?.type, "microsoftTeams");
    if (trigger?.type !== "microsoftTeams") return;
    assert.equal(trigger.tenantId.length, TRIGGER_MAX_ID_LENGTH);
    assert.equal(trigger.teamIds.length, TRIGGER_MAX_FILTER_IDS);
    assert.deepEqual(trigger.channelIds, ["channel-1", "channel-2"]);
    assert.equal(trigger.messageContains.length, TRIGGER_MAX_KEYWORD_LENGTH);
    assert.equal(trigger.messageContains.includes("\n"), false);
    assert.equal(trigger.messageContainsIsRegex, true);
    assert.equal(trigger.blockUnauthenticatedTeamsUsers, true);
  });

  it("keeps at most eight valid listeners and drops malformed group members", () => {
    const listeners = [
      ...Array.from({ length: TRIGGER_MAX_GROUP_LISTENERS + 2 }, (_, index) => ({ type: "cron", schedule: `0 ${index} * * *` })),
    ];
    const group = parseStoredTrigger({ type: "group", listeners: [{ type: "unknown" }, ...listeners] });
    assert.equal(group?.type, "group");
    assert.equal(group?.type === "group" ? group.listeners.length : 0, TRIGGER_MAX_GROUP_LISTENERS);
    assert.equal(parseStoredTrigger({ type: "group", listeners: [{ type: "unknown" }] }), null);
    assert.deepEqual(parseStoredTrigger([{ type: "cron", schedule: "@daily" }]), { type: "cron", schedule: "@daily" });
  });

  it("normalizes reactions and de-duplicates only emojis that match the accepted vocabulary", () => {
    const trigger = parseStoredTrigger({
      type: "slack",
      channel: ` #${"c".repeat(TRIGGER_MAX_CHANNEL_LENGTH + 1)} `,
      match: { kind: "reaction", emoji: [":EYES:", "eyes", "bad emoji", "+1"] },
    });
    assert.equal(trigger?.type, "slack");
    if (trigger?.type !== "slack" || trigger.match.kind !== "reaction") return;
    assert.equal(trigger.channel.length, TRIGGER_MAX_CHANNEL_LENGTH);
    assert.deepEqual(trigger.match.emoji, ["eyes", "+1"]);
    assert.equal(trigger.match.emoji?.length, Math.min(trigger.match.emoji?.length ?? 0, TRIGGER_MAX_REACTION_EMOJI));
    assert.equal(normalizeReactionEmoji(":eyes:"), "eyes");
    assert.equal(REACTION_EMOJI_PATTERN.test("eye_s+1"), true);
    assert.equal(REACTION_EMOJI_PATTERN.test("two words"), false);
  });

  it("requires a repository and a supported GitHub event, with a valid branch for CI", () => {
    const trigger = parseStoredTrigger({
      type: "github",
      repo: ` org/repo${"x".repeat(TRIGGER_MAX_REPO_LENGTH)} `,
      events: ["pr-opened", "unknown", "pr-opened", "ci-passed"],
      ciBranch: ` ${"m".repeat(TRIGGER_MAX_BRANCH_LENGTH + 10)} `,
      userAllowlist: ["@@Ada", "ada", " Grace ", "", ...Array.from({ length: TRIGGER_MAX_ALLOWLIST_LOGINS }, (_, index) => `user-${index}`)],
    });
    assert.equal(trigger?.type, "github");
    if (trigger?.type !== "github") return;
    assert.equal(trigger.repo.length, TRIGGER_MAX_REPO_LENGTH);
    assert.deepEqual(trigger.events, ["pr-opened", "ci-passed"]);
    assert.equal(trigger.ciBranch?.length, TRIGGER_MAX_BRANCH_LENGTH);
    assert.deepEqual(trigger.userAllowlist?.slice(0, 2), ["Ada", "Grace"]);
    assert.equal(trigger.userAllowlist?.length, TRIGGER_MAX_ALLOWLIST_LOGINS);
    assert.equal(GITHUB_EVENT_KINDS.includes("pr-opened"), true);

    assert.equal(parseStoredTrigger({ type: "github", repo: "org/repo", events: ["ci-passed"], ciBranch: "bad branch" }), null);
    assert.equal(parseStoredTrigger({ type: "github", repo: "org/repo", events: ["pr-opened"], ciBranch: "main" })?.type, "github");
  });

  it("accepts only the supported cases for Linear, Sentry and PagerDuty listeners", () => {
    assert.deepEqual(parseStoredTrigger({ type: "linear", event: { case: "statusChanged", statusIds: ["s1", "s1"] }, projectIds: ["p1"], teamIds: [] }), {
      type: "linear", event: { case: "statusChanged", statusIds: ["s1"] }, projectIds: ["p1"], teamIds: [],
    });
    assert.equal(parseStoredTrigger({ type: "linear", event: { case: "made-up" } }), null);
    assert.deepEqual(parseStoredTrigger({ type: "sentry", event: { case: "issueAny" }, projectIds: [] }), {
      type: "sentry", event: { case: "issueAny" }, projectIds: [],
    });
    assert.equal(parseStoredTrigger({ type: "sentry", event: { case: "incidentAny" } }), null);
    assert.deepEqual(parseStoredTrigger({ type: "pagerduty", event: { case: "incidentEscalated" }, serviceIds: ["svc"] }), {
      type: "pagerduty", event: { case: "incidentEscalated" }, serviceIds: ["svc"],
    });
  });

  it("serializes stable trigger identities while retaining a cron's exact schedule", () => {
    const trigger = parseStoredTrigger({ type: "group", listeners: [
      { type: "slack", channel: " #ops ", match: { kind: "mention" } },
      { type: "cron", schedule: " 0 9 * * 1-5 " },
    ] });
    assert.deepEqual(serializeStoredTrigger(trigger!), {
      type: "group",
      listeners: [
        { type: "slack", channel: "#ops", match: { kind: "mention" } },
        { type: "cron", schedule: "0 9 * * 1-5" },
      ],
    });
    assert.equal(triggerIdentity({ type: "cron", schedule: "0 9 * * *" }), "cron:0 9 * * *");
    assert.equal(triggerIdentity(trigger!), JSON.stringify(serializeStoredTrigger(trigger!)));
  });
});

describe("matching an event to a listener", () => {
  it("matches Slack channel scopes without crossing distinct sigils", () => {
    assert.equal(slackScopeMatches(TRIGGER_ANY_SCOPE, "#anything"), true);
    assert.equal(slackScopeMatches("ops", "#OPS"), true);
    assert.equal(slackScopeMatches("#ops", "ops"), true);
    assert.equal(slackScopeMatches("#ops", "@ops"), false);
  });

  it("keeps Slack messages, mentions and reactions in their own match modes", () => {
    const mention = parseStoredTrigger({ type: "slack", channel: "#ops", match: { kind: "mention" } })!;
    const message = parseStoredTrigger({ type: "slack", channel: "#ops", match: { kind: "message" } })!;
    const keyword = parseStoredTrigger({ type: "slack", channel: "#ops", match: { kind: "keyword", keyword: "Deploy" } })!;
    const reaction = parseStoredTrigger({ type: "slack", channel: "#ops", match: { kind: "reaction", emoji: ["eyes"], bySelf: true } })!;
    assert.equal(slackListenerMatches(mention as never, { channel: "#ops", isMention: true, text: "hi" }), true);
    assert.equal(slackListenerMatches(mention as never, { channel: "#ops", isMention: false, text: "hi" }), false);
    assert.equal(slackListenerMatches(message as never, { channel: "#ops", text: "hello" }), true);
    assert.equal(slackListenerMatches(message as never, { channel: "#ops", reactionEmoji: ":eyes:" }), false);
    assert.equal(slackListenerMatches(keyword as never, { channel: "#ops", text: "please deploy now" }), true);
    assert.equal(slackListenerMatches(reaction as never, { channel: "#ops", reactionEmoji: ":eyes:", isSelf: false }), false);
    assert.equal(slackListenerMatches(reaction as never, { channel: "#ops", reactionEmoji: ":eyes:", isSelf: true }), true);
  });

  it("matches GitHub repositories case-insensitively and gates CI by branch rather than allowlist", () => {
    const listener = parseStoredTrigger({ type: "github", repo: "org/repo", events: ["pr-opened", "ci-passed"], ciBranch: "main", userAllowlist: ["Ada"] })!;
    assert.equal(githubListenerMatches(listener as never, { repo: "ORG/REPO", kind: "pr-opened", prOwner: "ada" }), true);
    assert.equal(githubListenerMatches(listener as never, { repo: "org/repo", kind: "pr-opened", prOwner: "grace" }), false);
    assert.equal(githubListenerMatches(listener as never, { repo: "org/repo", kind: "ci-passed", branch: "main", actor: "grace" }), true);
    assert.equal(githubListenerMatches(listener as never, { repo: "org/repo", kind: "ci-passed", branch: "other" }), false);
    assert.equal(githubListenerMatches(listener as never, { repo: "org/repo", kind: "pr-merged" }), false);
  });

  it("keeps Microsoft Teams roots, auth and regex matching inside their declared scope", () => {
    const listener = parseStoredTrigger({
      type: "microsoftTeams", tenantId: "tenant", teamId: "team", teamIds: [], channelIds: ["channel"],
      messageContains: "release", messageContainsIsRegex: false, blockUnauthenticatedTeamsUsers: true,
    })!;
    assert.equal(listenerMatchesEvent(listener as never, { source: "microsoftTeams", tenantId: "tenant", teamId: "team", channelId: "channel", text: "Release notes", rootMessageId: "root" }, { platformMatched: true }), true);
    assert.equal(listenerMatchesEvent(listener as never, { source: "microsoftTeams", tenantId: "tenant", teamId: "team", channelId: "channel", text: "Release notes" }, { platformMatched: false }), false);
    assert.equal(listenerMatchesEvent(listener as never, { source: "microsoftTeams", tenantId: "tenant", teamId: "team", channelId: "channel", text: "Release notes" }, { platformMatched: true }), true);

    const regex = parseStoredTrigger({ ...listener, type: "microsoftTeams", messageContainsIsRegex: true })!;
    assert.equal(listenerMatchesEvent(regex as never, { source: "microsoftTeams", tenantId: "tenant", teamId: "team", channelId: "channel", text: "Release notes" }, { platformMatched: true }), true);
    assert.equal(listenerMatchesEvent(regex as never, { source: "microsoftTeams", tenantId: "tenant", teamId: "team", channelId: "channel", text: "Release notes" }, { platformMatched: false }), false);
  });

  it("matches source-specific ids, event kinds and alternative listeners", () => {
    const trigger = parseStoredTrigger({ type: "group", listeners: [
      { type: "linear", event: { case: "statusChanged", statusIds: ["done"] }, projectIds: ["project"], teamIds: [] },
      { type: "sentry", event: { case: "issueAny" }, projectIds: [] },
    ] })!;
    assert.equal(triggerMatchesEvent(trigger, { source: "linear", event: "statusChanged", projectId: "project", statusId: "done" }), true);
    assert.equal(triggerMatchesEvent(trigger, { source: "linear", event: "statusChanged", projectId: "other", statusId: "done" }), false);
    assert.equal(triggerMatchesEvent(trigger, { source: "sentry", event: "issueResolved" }), true);
    assert.equal(triggerMatchesEvent(parseStoredTrigger({ type: "cron", schedule: "@daily" })!, { source: "cron" }), false);
  });
});

describe("describing an event for context", () => {
  it("keeps the short event summary bounded and escapes a context block", () => {
    assert.equal(describeTriggerEvent({ source: "slack", sender: "Ada", channel: "#ops", text: "ship it" }), 'Ada in #ops: "ship it"');
    const long = describeTriggerEvent({ source: "slack", sender: "Ada", channel: "#ops", text: "x".repeat(200) });
    assert.equal(long.length, 120 + 'Ada in #ops: ""'.length);
    const block = buildTriggerEventContextBlock({ source: "slack", text: "<script>", channel: "#ops" });
    assert.equal(block.includes("<script>"), false);
    assert.match(block, /^<slack_message>\n/);
    assert.match(buildTriggerEventContextBlock({ source: "unknown" }), /^<trigger_event>/);
  });
});
