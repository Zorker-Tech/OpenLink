/**
 * The automations a client can list, and what a schedule may be.
 *
 * A trigger is either one listener or a group of them, and every listener is described the same way: what it watches,
 * where, and (for github) by whom, so a list of automations reads as sentences rather than as stored shapes.
 */

export const TRIGGER_ANY_SCOPE = "*";
export const GITHUB_EVENT_KINDS = ["pr-opened", "pr-pushed", "pr-merged", "review-requested", "review-approved", "review-changes-requested", "review-commented", "pr-comment", "inline-review-comment", "review-thread-resolved", "review-thread-unresolved", "issue-assigned", "ci-passed", "ci-failed"] as const;
export const LINEAR_EVENT_CASES = ["issueCreated", "statusChanged", "endOfCycle"] as const;
export const SENTRY_EVENT_CASES = ["issueCreated", "issueResolved", "issueAssigned", "issueArchived", "issueUnresolved", "issueAny"] as const;
export const PAGERDUTY_EVENT_CASES = ["incidentTriggered", "incidentAcknowledged", "incidentResolved", "incidentEscalated", "incidentAny"] as const;
export const TRIGGER_MAX_GROUP_LISTENERS = 8;
export const TRIGGER_MAX_REACTION_EMOJI = 8;
export const REACTION_EMOJI_PATTERN = /^[a-z0-9_+-]+$/;
export const LISTENER_INTEGRATION_PLATFORMS = ["github", "slack"] as const;
export const AUTOMATION_WAKE_CUE = "[routine]";

export type CronTrigger = { type: "cron"; schedule: string };

/** The ways a Slack listener may match a message. */
export type SlackMatch = { kind: "mention" } | { kind: "message" } | { kind: "keyword"; keyword: string } | { kind: "reaction"; emoji?: string[]; bySelf?: boolean };

export type SlackTrigger = { type: "slack"; channel: string; match: SlackMatch };

export type GithubTrigger = { type: "github"; repo: string; events: string[]; ciBranch?: string; userAllowlist?: string[] };

export type MicrosoftTeamsTrigger = { type: "microsoftTeams"; tenantId: string; teamId: string; teamIds: string[]; channelIds: string[]; messageContains: string; messageContainsIsRegex: boolean; blockUnauthenticatedTeamsUsers: boolean };

/** The linear events a listener can watch, each with the ids it narrows to. */
export type LinearEvent = { case: "issueCreated" } | { case: "statusChanged"; statusIds: string[] } | { case: "endOfCycle"; cycleIds: string[] };

export type LinearTrigger = { type: "linear"; event: LinearEvent; projectIds: string[]; teamIds: string[] };

/** A case-based event: sentry and pagerduty name their events the same way. */
export type CaseEvent = { case: string };

export type SentryTrigger = { type: "sentry"; event: CaseEvent; projectIds: string[] };

export type PagerDutyTrigger = { type: "pagerduty"; event: CaseEvent; serviceIds: string[] };

export type CaseTrigger = LinearTrigger | SentryTrigger | PagerDutyTrigger;

export type EventTrigger = SlackTrigger | GithubTrigger | MicrosoftTeamsTrigger | CaseTrigger;

export type AutomationTriggerMember = CronTrigger | EventTrigger;

/** The listeners a group holds: at least two, since one listener is not a group. */
export type TriggerGroupListeners = [AutomationTriggerMember, AutomationTriggerMember, ...AutomationTriggerMember[]];

export type AutomationTrigger = AutomationTriggerMember | { type: "group"; listeners: TriggerGroupListeners };

/** The two github events that are about CI. */
const GITHUB_CI_EVENT_KINDS: ReadonlySet<string> = new Set(["ci-passed", "ci-failed"]);

/** A colon on either side of a reaction's name is decoration. */
const REACTION_EMOJI_EDGES = /^:+|:+$/g;

/** A repository is one path segment, a slash, and another. */
const GITHUB_REPO_PATTERN = /^[^\s/]+\/[^\s/]+$/;

/** The characters and shapes a branch name may not carry. */
const INVALID_BRANCH_PATTERN = /[\s~^:?*[\\]|^[-/]|\/$|\.\.|@\{/;

/** Whether this github event kind is one of the two that report on CI. */
export const isGithubCiEventKind = (kind: string): boolean => GITHUB_CI_EVENT_KINDS.has(kind);

/** A reaction name as Slack writes it: trimmed, without the colons, and folded to lower case. */
export const normalizeReactionEmoji = (raw: string): string => {
  const bare = raw.trim().replace(REACTION_EMOJI_EDGES, "");
  const head = bare.split("::")[0];
  return (head ?? bare).trim().toLowerCase();
};

/** Whether this is an "owner/name" repository. */
export const isValidGithubRepo = (repo: string): boolean => GITHUB_REPO_PATTERN.test(repo);

/** Whether this is a branch name git will accept. */
export const isValidGitBranch = (branch: string): boolean => {
  if (!(branch.length > 0)) return false;
  return !INVALID_BRANCH_PATTERN.test(branch);
};

/** A trigger that runs on a cron schedule. */
export const cronTrigger = (schedule: string): CronTrigger => ({ type: "cron", schedule });

/** Every listener a trigger holds; a single listener is a list of one. */
export const triggerList = (trigger: AutomationTrigger): AutomationTriggerMember[] => (trigger.type === "group" ? trigger.listeners : [trigger]);

/** One trigger made of a list of listeners, or null when the list is empty. */
export const triggerFromList = (members: readonly AutomationTriggerMember[]): AutomationTrigger | null => {
  const [first, second] = members;
  if (first == null) return null;
  if (second == null) return first;
  return { type: "group", listeners: [first, second, ...members.slice(2)] };
};

/** Whether this candidate is one of the two chat listeners that carry a scope. */
const isSlackOrGithub = (candidate: AutomationTriggerMember): candidate is SlackTrigger | GithubTrigger =>
  candidate.type === "slack" || candidate.type === "github";

/** Whether this candidate is a listener rather than a schedule. */
const isEventTrigger = (candidate: AutomationTriggerMember): candidate is EventTrigger => candidate.type !== "cron";

/** Whether this candidate is a schedule. */
const isCronTrigger = (candidate: AutomationTriggerMember): candidate is CronTrigger => candidate.type === "cron";

/** The chat listeners a trigger holds. */
export const triggerListeners = (source: AutomationTrigger): Array<SlackTrigger | GithubTrigger> => triggerList(source).filter(isSlackOrGithub);

/** The event listeners a trigger holds. */
export const triggerEventTriggers = (source: AutomationTrigger): EventTrigger[] => triggerList(source).filter(isEventTrigger);

/** The cron schedules a trigger holds. */
export const triggerCronSchedules = (source: AutomationTrigger): string[] => triggerList(source).flatMap((member) => (isCronTrigger(member) ? [member.schedule] : []));

/** The first cron schedule a trigger holds, or null when it holds none. */
export const triggerSchedule = (source: AutomationTrigger): string | null => triggerCronSchedules(source)[0] ?? null;

/** The parts of a list joined the way a sentence joins them: "a", "a or b", "a, b, or c". */
const joinWithOr = (parts: readonly string[]): string => {
  if (parts.length === 0) return "";
  if (parts.length === 1) return parts[0] ?? "";
  if (parts.length === 2) return `${parts[0]} or ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")}, or ${parts.at(-1)}`;
};

/** Where on Slack a listener is watching. */
const slackScope = (channel: string): string => (channel === TRIGGER_ANY_SCOPE ? "anywhere on Slack" : `in ${channel}`);

/** What a Slack listener reacts to, said in words. */
const describeSlackMatch = (match: SlackTrigger["match"], scope: string): string => {
  if (match.kind === "mention") return `When @mentioned ${scope}`;
  if (match.kind === "keyword") return `When "${match.keyword}" is mentioned ${scope}`;
  if (match.kind === "message") return `On any message ${scope}`;
  const emoji = match.emoji ?? [];
  const names = joinWithOr(emoji.map((name) => `:${name}:`));
  if (match.bySelf === true) return `When you react${emoji.length > 0 ? ` ${names}` : ""} ${scope}`;
  return `On ${emoji.length > 0 ? names : "a reaction"} ${scope}`;
};

/** What a Slack listener watches, in one sentence. */
export const describeSlackListener = (listener: SlackTrigger): string => describeSlackMatch(listener.match, slackScope(listener.channel));

const GITHUB_PHRASES: Record<string, string> = { "pr-opened": "a PR opens", "pr-pushed": "a PR is updated", "pr-merged": "a PR merges", "review-requested": "a review is requested", "review-approved": "a review approves a PR", "review-changes-requested": "a review requests changes", "review-commented": "a review comments on a PR", "pr-comment": "a PR comment lands", "inline-review-comment": "an inline review comment lands", "review-thread-resolved": "a review thread is resolved", "review-thread-unresolved": "a review thread is reopened", "issue-assigned": "an issue is assigned", "ci-passed": "CI passes", "ci-failed": "CI fails" };

/** One github event as a phrase, with the CI branch when the event is about CI. */
const describeGithubEvent = (kind: string, ciBranch: string | undefined): string => {
  const phrase = GITHUB_PHRASES[kind] ?? kind;
  return isGithubCiEventKind(kind) && ciBranch != null ? `${phrase} on ${ciBranch}` : phrase;
};

/** A github login with the @ a sentence wants in front of it. */
const atLogin = (login: string): string => (login.startsWith("@") ? login : `@${login}`);

/** What a github listener watches, in one sentence, naming the people who may trigger it. */
export const describeGithubListener = (listener: GithubTrigger): string => {
  const phrases = listener.events.map((kind) => describeGithubEvent(kind, listener.ciBranch));
  const base = `When ${joinWithOr(phrases)} in ${listener.repo}`;
  const allowlist = listener.userAllowlist;
  if (allowlist == null || allowlist.length === 0) return base;
  return `${base} (by ${joinWithOr(allowlist.map(atLogin))})`;
};

/** The linear events, each as the phrase it becomes. */
const LINEAR_CASE_PHRASES: Record<string, string> = { issueCreated: "a Linear issue is created", statusChanged: "a Linear issue changes status", endOfCycle: "a Linear cycle ends" };

/** The sentry events, each as the phrase it becomes. */
const SENTRY_CASE_PHRASES: Record<string, string> = { issueCreated: "a Sentry issue is created", issueResolved: "a Sentry issue is resolved", issueAssigned: "a Sentry issue is assigned", issueArchived: "a Sentry issue is archived", issueUnresolved: "a Sentry issue becomes unresolved", issueAny: "a Sentry issue changes" };

/** The pagerduty events, each as the phrase it becomes. */
const PAGERDUTY_CASE_PHRASES: Record<string, string> = { incidentTriggered: "a PagerDuty incident is triggered", incidentAcknowledged: "a PagerDuty incident is acknowledged", incidentResolved: "a PagerDuty incident is resolved", incidentEscalated: "a PagerDuty incident is escalated", incidentAny: "a PagerDuty incident changes" };

/** Each case platform's events, by the platform's trigger type. */
const CASE_PHRASES: Record<string, Record<string, string>> = { linear: LINEAR_CASE_PHRASES, sentry: SENTRY_CASE_PHRASES, pagerduty: PAGERDUTY_CASE_PHRASES };

/** What any listener watches, in one sentence. */
export const describeListener = (listener: EventTrigger): string => {
  if (listener.type === "slack") return describeSlackListener(listener);
  if (listener.type === "github") return describeGithubListener(listener);
  if (listener.type === "microsoftTeams") {
    return listener.messageContains === "" ? "On a Microsoft Teams message" : `When a Microsoft Teams message matches "${listener.messageContains}"`;
  }
  return `When ${CASE_PHRASES[listener.type]?.[listener.event.case] ?? listener.event.case}`;
};
