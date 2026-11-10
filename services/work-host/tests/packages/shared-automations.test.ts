import { test } from "node:test"
import assert from "node:assert/strict"

import {
  AUTOMATION_WAKE_CUE,
  cronTrigger,
  describeGithubListener,
  describeListener,
  describeSlackListener,
  GITHUB_EVENT_KINDS,
  isGithubCiEventKind,
  isValidGitBranch,
  isValidGithubRepo,
  LINEAR_EVENT_CASES,
  LISTENER_INTEGRATION_PLATFORMS,
  normalizeReactionEmoji,
  PAGERDUTY_EVENT_CASES,
  REACTION_EMOJI_PATTERN,
  SENTRY_EVENT_CASES,
  TRIGGER_ANY_SCOPE,
  TRIGGER_MAX_GROUP_LISTENERS,
  TRIGGER_MAX_REACTION_EMOJI,
  triggerCronSchedules,
  triggerEventTriggers,
  triggerFromList,
  triggerList,
  triggerListeners,
  triggerSchedule,
  type AutomationTrigger,
  type AutomationTriggerMember,
  type CronTrigger,
  type EventTrigger,
  type GithubTrigger,
  type LinearTrigger,
  type MicrosoftTeamsTrigger,
  type PagerDutyTrigger,
  type SentryTrigger,
  type SlackTrigger,
} from "../../source/shared/automations.ts"

const cron = (schedule: string): CronTrigger => ({ type: "cron", schedule })
const slack = (channel: string, match: SlackTrigger["match"]): SlackTrigger => ({ type: "slack", channel, match })
const github = (repo: string, events: string[], extra: Partial<GithubTrigger> = {}): GithubTrigger => ({ type: "github", repo, events, ...extra })
const linear: LinearTrigger = { type: "linear", event: { case: "issueCreated" }, projectIds: [], teamIds: [] }
const sentry: SentryTrigger = { type: "sentry", event: { case: "issueAny" }, projectIds: [] }
const pagerduty: PagerDutyTrigger = { type: "pagerduty", event: { case: "incidentAny" }, serviceIds: [] }

test("the automation vocabulary is the one the host stores and the backend accepts", () => {
  assert.equal(TRIGGER_ANY_SCOPE, "*")
  assert.equal(AUTOMATION_WAKE_CUE, "[routine]")
  assert.equal(TRIGGER_MAX_GROUP_LISTENERS, 8)
  assert.equal(TRIGGER_MAX_REACTION_EMOJI, 8)
  assert.deepEqual([...LISTENER_INTEGRATION_PLATFORMS], ["github", "slack"])
  assert.deepEqual([...LINEAR_EVENT_CASES], ["issueCreated", "statusChanged", "endOfCycle"])
  assert.deepEqual([...SENTRY_EVENT_CASES], ["issueCreated", "issueResolved", "issueAssigned", "issueArchived", "issueUnresolved", "issueAny"])
  assert.deepEqual([...PAGERDUTY_EVENT_CASES], ["incidentTriggered", "incidentAcknowledged", "incidentResolved", "incidentEscalated", "incidentAny"])
  assert.equal(GITHUB_EVENT_KINDS.length, 14)
  assert.deepEqual([...GITHUB_EVENT_KINDS].slice(-2), ["ci-passed", "ci-failed"])
  assert.equal(REACTION_EMOJI_PATTERN.test("thumbsup"), true)
  assert.equal(REACTION_EMOJI_PATTERN.test("+1"), true)
  assert.equal(REACTION_EMOJI_PATTERN.test(":eyes:"), false, "the pattern is the bare name, without colons")
})

test("a github event is a CI event only for the two CI kinds", () => {
  assert.equal(isGithubCiEventKind("ci-passed"), true)
  assert.equal(isGithubCiEventKind("ci-failed"), true)
  assert.equal(isGithubCiEventKind("pr-opened"), false)
  assert.equal(isGithubCiEventKind("CI-PASSED"), false)
  assert.equal(isGithubCiEventKind(""), false)
})

test("a reaction name is trimmed, uncoloned, cut at a scope separator, and folded to lower case", () => {
  assert.equal(normalizeReactionEmoji(":eyes:"), "eyes")
  assert.equal(normalizeReactionEmoji("::Eyes::"), "eyes")
  assert.equal(normalizeReactionEmoji("  smile  "), "smile")
  assert.equal(normalizeReactionEmoji("a::b"), "a", "a scope separator keeps only what comes before it")
  assert.equal(normalizeReactionEmoji("a ::b"), "a", "the part before the separator is trimmed too")
  assert.equal(normalizeReactionEmoji("::"), "")
})

test("a repository is one segment, a slash, and another, and a branch name has no forbidden shapes", () => {
  assert.equal(isValidGithubRepo("owner/name"), true)
  assert.equal(isValidGithubRepo("owner/name/extra"), false)
  assert.equal(isValidGithubRepo("/name"), false)
  assert.equal(isValidGithubRepo("owner/"), false)
  assert.equal(isValidGithubRepo("own er/name"), false)

  assert.equal(isValidGitBranch("main"), true)
  assert.equal(isValidGitBranch("feature/one"), true)
  assert.equal(isValidGitBranch(""), false)
  assert.equal(isValidGitBranch("a b"), false)
  assert.equal(isValidGitBranch("a..b"), false)
  assert.equal(isValidGitBranch("-a"), false)
  assert.equal(isValidGitBranch("a/"), false)
  assert.equal(isValidGitBranch("a@{b"), false)
  assert.equal(isValidGitBranch("a?b"), false)
  assert.equal(isValidGitBranch(7 as never), false, "only text with a length can be a branch name")
})

test("a trigger is a single listener or a group, and its listeners can be read back out", () => {
  assert.deepEqual(cronTrigger("0 9 * * *"), { type: "cron", schedule: "0 9 * * *" })
  assert.deepEqual(triggerList(cron("a")), [{ type: "cron", schedule: "a" }])
  const group: AutomationTrigger = { type: "group", listeners: [cron("a"), slack("#x", { kind: "mention" })] }
  assert.deepEqual(triggerList(group), group.listeners)

  assert.equal(triggerFromList([]), null)
  assert.deepEqual(triggerFromList([cron("a")]), { type: "cron", schedule: "a" })
  assert.deepEqual(triggerFromList([cron("a"), slack("#x", { kind: "mention" })]), { type: "group", listeners: [cron("a"), slack("#x", { kind: "mention" })] })
  assert.deepEqual(triggerFromList([cron("a"), cron("b"), cron("c")]), { type: "group", listeners: [cron("a"), cron("b"), cron("c")] })

  assert.deepEqual(triggerListeners(group), [slack("#x", { kind: "mention" })])
  assert.deepEqual(
    triggerListeners({ type: "group", listeners: [cron("a"), slack("#x", { kind: "mention" }), linear] }),
    [slack("#x", { kind: "mention" })],
    "a case trigger is not one of the two chat listeners",
  )
  assert.deepEqual(triggerEventTriggers(group), [slack("#x", { kind: "mention" })])
  assert.deepEqual(triggerCronSchedules(group), ["a"])
  assert.equal(triggerSchedule(group), "a")
  assert.equal(triggerSchedule(slack("#x", { kind: "mention" })), null)
  assert.deepEqual(triggerCronSchedules({ type: "group", listeners: [cron("a"), cron("b"), sentry] }), ["a", "b"])
  assert.deepEqual(triggerEventTriggers({ type: "group", listeners: [cron("a"), github("a/b", ["pr-opened"]), linear] }), [github("a/b", ["pr-opened"]), linear])
})

test("a Slack listener is described by what it matches and where", () => {
  assert.equal(describeSlackListener(slack("*", { kind: "mention" })), "When @mentioned anywhere on Slack")
  assert.equal(describeSlackListener(slack("#ops", { kind: "message" })), "On any message in #ops")
  assert.equal(describeSlackListener(slack("#ops", { kind: "keyword", keyword: "deploy" })), 'When "deploy" is mentioned in #ops')
  assert.equal(describeSlackListener(slack("#ops", { kind: "reaction", emoji: ["eyes"] })), "On :eyes: in #ops")
  assert.equal(describeSlackListener(slack("#ops", { kind: "reaction" })), "On a reaction in #ops")
  assert.equal(describeSlackListener(slack("#ops", { kind: "reaction", emoji: ["eyes", "fire"] })), "On :eyes: or :fire: in #ops")
  assert.equal(describeSlackListener(slack("#ops", { kind: "reaction", emoji: ["eyes"], bySelf: true })), "When you react :eyes: in #ops")
  assert.equal(describeSlackListener(slack("#ops", { kind: "reaction", bySelf: true })), "When you react in #ops")
})

test("a github listener is described by its events, the CI branch, and the people allowed to trigger it", () => {
  assert.equal(describeGithubListener(github("a/b", ["pr-opened"])), "When a PR opens in a/b")
  assert.equal(describeGithubListener(github("a/b", ["pr-opened", "pr-merged"])), "When a PR opens or a PR merges in a/b")
  assert.equal(describeGithubListener(github("a/b", ["pr-opened", "pr-merged", "ci-failed"])), "When a PR opens, a PR merges, or CI fails in a/b")
  assert.equal(describeGithubListener(github("a/b", ["ci-passed"], { ciBranch: "main" })), "When CI passes on main in a/b")
  assert.equal(describeGithubListener(github("a/b", ["ci-passed"])), "When CI passes in a/b", "a CI event without a branch is not qualified")
  assert.equal(describeGithubListener(github("a/b", ["pr-opened"], { ciBranch: "main" })), "When a PR opens in a/b", "a branch only qualifies a CI event")
  assert.equal(describeGithubListener(github("a/b", ["unknown-kind"])), "When unknown-kind in a/b", "an unknown kind is its own name")
  assert.equal(describeGithubListener(github("a/b", ["pr-opened"], { userAllowlist: ["ada", "@grace"] })), "When a PR opens in a/b (by @ada or @grace)")
  assert.equal(describeGithubListener(github("a/b", ["pr-opened"], { userAllowlist: [] })), "When a PR opens in a/b")
})

test("any listener is described in one sentence, whatever platform it comes from", () => {
  assert.equal(describeListener(slack("*", { kind: "mention" })), "When @mentioned anywhere on Slack")
  assert.equal(describeListener(github("a/b", ["pr-merged"])), "When a PR merges in a/b")
  const teams: MicrosoftTeamsTrigger = { type: "microsoftTeams", tenantId: "t", teamId: "team", teamIds: ["team"], channelIds: ["c"], messageContains: "", messageContainsIsRegex: false, blockUnauthenticatedTeamsUsers: false }
  assert.equal(describeListener(teams), "On a Microsoft Teams message")
  assert.equal(describeListener({ ...teams, messageContains: "deploy" }), 'When a Microsoft Teams message matches "deploy"')
  assert.equal(describeListener(linear), "When a Linear issue is created")
  assert.equal(describeListener({ type: "linear", event: { case: "statusChanged", statusIds: [] }, projectIds: [], teamIds: [] }), "When a Linear issue changes status")
  assert.equal(describeListener(sentry), "When a Sentry issue changes")
  assert.equal(describeListener(pagerduty), "When a PagerDuty incident changes")
  assert.equal(
    describeListener({ type: "linear", event: { case: "unknown" }, projectIds: [], teamIds: [] } as unknown as EventTrigger),
    "When unknown",
    "an event the phrases do not know is its own case",
  )
})
