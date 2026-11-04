/** Builds the counterpart automation workflow payload at the cloud protocol boundary. */

import { Buffer } from "node:buffer";
import {
  CronTrigger,
  GitCICompletedEvent,
  GitCICompletionCondition,
  GitIssueAssignedEvent,
  GitPullRequestAction,
  GitPullRequestEvent,
  GitPullRequestReviewCommentEvent,
  GitPullRequestReviewEvent,
  GitPullRequestReviewRequestedEvent,
  GitReviewThreadEvent,
  GitTrigger,
  Prompt,
  SlackAnyReactionAddedTrigger,
  SlackMentionTrigger,
  SlackReactionAddedTrigger,
  SlackTrigger,
  Trigger,
  Workflow,
  type GitTrigger as ProtoGitTrigger,
} from "../proto/generated/aiserver/v1/automations_pb.ts";
import { expandCronAlias, splitScheduleTimeZone } from "../../../shared/automation-schedule.ts";
import {
  isGithubCiEventKind,
  triggerCronSchedules,
  triggerEventTriggers,
  triggerListeners,
  type AutomationTrigger,
  type EventTrigger,
  type GithubTrigger,
} from "../../../shared/automations.ts";
import { backendCloudTrigger, type BackendCloudTrigger } from "../cursor-backend/slate-automation-cloud-trigger-adapter.ts";
import { stableAutomationId } from "../../../host/automations/automation-id.ts";
import { sha256Hex } from "../../../host/sha256.ts";

interface AutomationDefinitionInput {
  readonly id: string;
  readonly name: string;
  readonly prompt: string;
  readonly isEnabled: boolean;
  readonly trigger: AutomationTrigger;
}

function buildSlackTrigger(
  listener: Extract<EventTrigger, { type: "slack" }>,
  emojiName?: string,
): BackendCloudTrigger {
  const channels = [listener.channel];
  switch (listener.match.kind) {
    case "mention":
      return new Trigger({ trigger: { case: "slackMention", value: new SlackMentionTrigger({ channels }) } }) as unknown as BackendCloudTrigger;
    case "reaction": {
      const onlyOwnerReactions = listener.match.bySelf === true;
      return new Trigger({
        trigger: {
          case: emojiName === undefined ? "slackAnyReactionAdded" : "slackReactionAdded",
          value: emojiName === undefined
            ? new SlackAnyReactionAddedTrigger({ channels, onlyOwnerReactions })
            : new SlackReactionAddedTrigger({ channels, emojiName, onlyOwnerReactions }),
        },
      }) as unknown as BackendCloudTrigger;
    }
    case "keyword":
      return new Trigger({ trigger: { case: "slackTrigger", value: new SlackTrigger({ channels, messageContains: listener.match.keyword, topLevelOnly: false }) } }) as unknown as BackendCloudTrigger;
    case "message":
      return new Trigger({ trigger: { case: "slackTrigger", value: new SlackTrigger({ channels, topLevelOnly: false }) } }) as unknown as BackendCloudTrigger;
  }
}

/** The event a github trigger carries, built from the repository it watches. */
type GithubEventValue = ProtoGitTrigger["event"];

/** One github listener event, as the upstream side names it. */
const GITHUB_EVENT_BUILDERS: Readonly<Record<string, (repos: string[]) => GithubEventValue>> = {
  "pr-opened": (repos) => ({ case: "pullRequest", value: new GitPullRequestEvent({ repos, prAction: GitPullRequestAction.OPENED }) }),
  "pr-pushed": (repos) => ({ case: "pullRequest", value: new GitPullRequestEvent({ repos, prAction: GitPullRequestAction.PUSHED }) }),
  "pr-merged": (repos) => ({ case: "pullRequest", value: new GitPullRequestEvent({ repos, prAction: GitPullRequestAction.MERGED }) }),
  "pr-comment": (repos) => ({ case: "pullRequest", value: new GitPullRequestEvent({ repos, prAction: GitPullRequestAction.COMMENTED }) }),
  "review-requested": (repos) => ({ case: "pullRequestReviewRequested", value: new GitPullRequestReviewRequestedEvent({ repos }) }),
  "review-approved": (repos) => ({ case: "pullRequestReview", value: new GitPullRequestReviewEvent({ repos, onApproved: true }) }),
  "review-changes-requested": (repos) => ({ case: "pullRequestReview", value: new GitPullRequestReviewEvent({ repos, onChangesRequested: true }) }),
  "review-commented": (repos) => ({ case: "pullRequestReview", value: new GitPullRequestReviewEvent({ repos, onCommented: true }) }),
  "inline-review-comment": (repos) => ({ case: "pullRequestReviewComment", value: new GitPullRequestReviewCommentEvent({ repos }) }),
  "review-thread-resolved": (repos) => ({ case: "reviewThread", value: new GitReviewThreadEvent({ repos, onResolved: true }) }),
  "review-thread-unresolved": (repos) => ({ case: "reviewThread", value: new GitReviewThreadEvent({ repos, onUnresolved: true }) }),
  "issue-assigned": (repos) => ({ case: "issueAssigned", value: new GitIssueAssignedEvent({ repos }) }),
};

function buildGithubTrigger(listener: GithubTrigger, event: string): BackendCloudTrigger {
  const repos = [`https://github.com/${listener.repo}`];
  const userAllowlist = [...listener.userAllowlist ?? []];
  const buildEvent = GITHUB_EVENT_BUILDERS[event];
  const value: GithubEventValue = buildEvent === undefined ? { case: undefined } : buildEvent(repos);
  return new Trigger({ trigger: { case: "git", value: new GitTrigger({ event: value, userAllowlist }) } }) as unknown as BackendCloudTrigger;
}

function buildCiTrigger(args: { repo: string; branch: string; condition: GitCICompletionCondition }): BackendCloudTrigger {
  return new Trigger({
    trigger: {
      case: "git",
      value: new GitTrigger({
        event: { case: "ciCompleted", value: new GitCICompletedEvent({ repos: [`https://github.com/${args.repo}`], condition: args.condition, branch: args.branch }) },
      }),
    },
  }) as unknown as BackendCloudTrigger;
}

function ciConditionOf(events: readonly string[]): GitCICompletionCondition | null {
  const passed = events.includes("ci-passed");
  const failed = events.includes("ci-failed");
  if (passed && failed) return GitCICompletionCondition.GIT_CI_COMPLETION_CONDITION_ANY;
  if (passed) return GitCICompletionCondition.GIT_CI_COMPLETION_CONDITION_SUCCESS;
  if (failed) return GitCICompletionCondition.GIT_CI_COMPLETION_CONDITION_FAILURE;
  return null;
}

function plainEventsOf(listener: GithubTrigger): string[] {
  return listener.events.filter((event) => !isGithubCiEventKind(event));
}

function ciTriggersFor(listener: GithubTrigger): BackendCloudTrigger[] {
  const condition = ciConditionOf(listener.events);
  if (listener.ciBranch === undefined || listener.ciBranch === "" || condition === null) return [];
  return [buildCiTrigger({ repo: listener.repo, branch: listener.ciBranch, condition })];
}

function plainTriggersFor(
  listener: GithubTrigger,
  allowlistForEvent?: (event: string) => readonly string[],
): BackendCloudTrigger[] {
  return plainEventsOf(listener).map((event) => buildGithubTrigger(
    allowlistForEvent === undefined
      ? listener
      : { ...listener, userAllowlist: [...allowlistForEvent(event)] },
    event,
  ));
}

function triggersForListener(listener: EventTrigger): BackendCloudTrigger[] {
  switch (listener.type) {
    case "slack": {
      const reactionEmojis = listener.match.kind === "reaction" ? listener.match.emoji ?? [] : [];
      return reactionEmojis.length === 0 ? [buildSlackTrigger(listener)] : reactionEmojis.map((emoji) => buildSlackTrigger(listener, emoji));
    }
    case "github": return [...plainTriggersFor(listener), ...ciTriggersFor(listener)];
    case "microsoftTeams":
    case "linear":
    case "sentry":
    case "pagerduty":
      return [backendCloudTrigger(listener)];
  }
}

function mergeAllowlists(existing: string[] | null, addition: string[] | null): string[] | null {
  if (existing === null || addition === null) return null;
  const combined = [...existing];
  for (const user of addition) {
    if (!combined.some((row) => row.toLowerCase() === user.toLowerCase())) combined.push(user);
  }
  return combined;
}

function groupedListenerTriggers(listenerList: readonly EventTrigger[]): BackendCloudTrigger[] {
  const plainMerged: EventTrigger[] = [];
  const githubEventsByRepo = new Map<string, string[]>();
  const githubAllowlistsByRepo = new Map<string, Map<string, string[] | null>>();
  const ciEventsByRepoBranch = new Map<string, { repo: string; branch: string; events: string[] }>();
  for (const listener of listenerList) {
    if (listener.type !== "github") {
      plainMerged.push(listener);
      continue;
    }
    const repositoryKey = listener.repo.toLowerCase();
    const ciKinds = listener.events.filter(isGithubCiEventKind);
    if (listener.ciBranch !== undefined && listener.ciBranch !== "" && ciKinds.length > 0) {
      const repositoryBranchKey = `${repositoryKey}\0${listener.ciBranch}`;
      const row = ciEventsByRepoBranch.get(repositoryBranchKey) ?? { repo: listener.repo, branch: listener.ciBranch, events: [] };
      for (const event of ciKinds) if (!row.events.includes(event)) row.events.push(event);
      ciEventsByRepoBranch.set(repositoryBranchKey, row);
    }
    const allowlist = listener.userAllowlist !== undefined && listener.userAllowlist.length > 0 ? [...listener.userAllowlist] : null;
    const allowlistsByEvent = githubAllowlistsByRepo.get(repositoryKey) ?? new Map<string, string[] | null>();
    githubAllowlistsByRepo.set(repositoryKey, allowlistsByEvent);
    const listenerEvents = plainEventsOf(listener);
    for (const event of listenerEvents) {
      allowlistsByEvent.set(event, allowlistsByEvent.has(event) ? mergeAllowlists(allowlistsByEvent.get(event) ?? null, allowlist) : allowlist);
    }
    const knownEvents = githubEventsByRepo.get(repositoryKey);
    if (knownEvents !== undefined) {
      for (const event of listenerEvents) if (!knownEvents.includes(event)) knownEvents.push(event);
      continue;
    }
    githubEventsByRepo.set(repositoryKey, [...listenerEvents]);
    plainMerged.push({ ...listener, events: [...listenerEvents] });
  }
  const ciTriggers: BackendCloudTrigger[] = [];
  for (const { repo, branch, events } of ciEventsByRepoBranch.values()) {
    const condition = ciConditionOf(events);
    if (condition !== null) ciTriggers.push(buildCiTrigger({ repo, branch, condition }));
  }
  return [
    ...plainMerged.flatMap((listener) => {
      if (listener.type !== "github") return triggersForListener(listener);
      const allowlistsByEvent = githubAllowlistsByRepo.get(listener.repo.toLowerCase());
      return plainTriggersFor(listener, (event) => allowlistsByEvent?.get(event) ?? []);
    }),
    ...ciTriggers,
  ];
}

function buildCronTrigger(args: { schedule: string; timeZone?: string | undefined }): BackendCloudTrigger {
  const { schedule: cronExpression, timeZone: scheduleZone } = splitScheduleTimeZone(args.schedule);
  const normalizedSchedule = expandCronAlias(cronExpression).replace(/^@every\b/i, "@every");
  const zone = scheduleZone ?? args.timeZone;
  const cron = zone !== undefined && !normalizedSchedule.startsWith("@every") ? `CRON_TZ=${zone} ${normalizedSchedule}` : normalizedSchedule;
  return new Trigger({ trigger: { case: "cron", value: new CronTrigger({ cron }) } }) as unknown as BackendCloudTrigger;
}

function triggersForListeners(listenerList: readonly EventTrigger[]): BackendCloudTrigger[] {
  const [singleListener] = listenerList;
  if (singleListener === undefined) return [];
  if (listenerList.length === 1) return triggersForListener(singleListener);
  return groupedListenerTriggers(listenerList);
}

export function cloudTriggersForInterop(trigger: AutomationTrigger, timeZone?: string | undefined): BackendCloudTrigger[] | null {
  if (triggerListeners(trigger).some((listener) => listener.type === "slack" && listener.channel.startsWith("@"))) return null;
  return [
    ...triggerCronSchedules(trigger).map((schedule) => buildCronTrigger({ schedule, timeZone })),
    ...triggersForListeners(triggerEventTriggers(trigger)),
  ];
}

export interface InteropCloudDefinition {
  readonly automationId: string;
  readonly enabled: boolean;
  readonly hash: string;
  readonly localId: string;
  readonly marker: string;
  readonly name: string;
  readonly workflow: Workflow;
}

export function buildCloudDefinitionForInterop(args: { agentId: string; automation: AutomationDefinitionInput; timeZone?: string | undefined; canScheduleElsewhere: boolean; markerPrefix: string }): InteropCloudDefinition | null {
  const triggerList = cloudTriggersForInterop(args.automation.trigger, args.timeZone);
  if (triggerList === null) return null;
  const workflow = new Workflow({ triggers: [...triggerList] as Trigger[], prompts: [new Prompt({ prompt: args.automation.prompt })] });
  const githubSubscriptionVersion = workflow.triggers.some((trigger) => trigger.trigger?.case === "git") ? "github-subscriptions-v1\0" : "";
  const hashPrefix = Buffer.from(`${githubSubscriptionVersion}${args.automation.id}\0${args.automation.name}\0${String(args.automation.isEnabled)}\0`);
  const hash = sha256Hex(Buffer.concat([hashPrefix, Buffer.from(workflow.toBinary())]));
  return {
    automationId: stableAutomationId({ agentId: args.agentId, localId: args.automation.id }),
    enabled: args.automation.isEnabled && args.canScheduleElsewhere,
    hash,
    localId: args.automation.id,
    marker: `${args.markerPrefix}${hash}`,
    name: args.automation.name,
    workflow,
  };
}
