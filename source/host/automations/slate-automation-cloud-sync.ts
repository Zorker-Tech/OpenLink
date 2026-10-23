/** Keeping the platform's automations in step with where they may be listedAutomations.

 * An automation that can be listedAutomations elsewhere is translated into the shape that side takes, hashed so its version is
 * visible from outside, and reconciled against what is already there: what is no longer wanted is pruned, who holds the
 * scheduling published is published, and a problem is reported without stopping the rest. */
import { ConnectError, Code } from "@connectrpc/connect";
import {
  CreateAutomationRequest,
  CronTrigger,
  DeleteAutomationRequest,
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
  GitTrigger as ProtoGitTrigger,
  ListSlateAutomationsRequest,
  Prompt,
  SlackAnyReactionAddedTrigger,
  SlackMentionTrigger,
  SlackReactionAddedTrigger,
  SlackTrigger,
  Trigger,
  UpdateAutomationRequest,
  Workflow,
} from "../../packages/proto/generated/aiserver/v1/automations_pb.ts";
import { expandCronAlias, splitScheduleTimeZone } from "../../shared/automation-schedule.ts";
import {
  isGithubCiEventKind,
  triggerCronSchedules,
  triggerEventTriggers,
  triggerListeners,
  type AutomationTrigger,
  type EventTrigger,
  type GithubTrigger,
} from "../../shared/automations.ts";
import { findSystemErrno } from "../../shared/system-errno.ts";
import { stableAutomationId } from "./automation-id.ts";
import { sha256Hex } from "../sha256.ts";
import { backendCloudTrigger, type BackendCloudTrigger } from "./slate-automation-cloud-trigger.ts";

export const SLATE_SHADOW_MARKER_PREFIX = "slate-shadow:";
const NO_DESIRED_CLOUD_AUTOMATION_IDS = new Set<string>();

export interface ScheduledCloudAutomation {
  readonly id: string;
  readonly name: string;
  readonly prompt: string;
  readonly isEnabled: boolean;
  readonly trigger: AutomationTrigger;
}

export function isServerSchedulable(automation: { readonly trigger: AutomationTrigger }): boolean {
  return !triggerListeners(automation.trigger).some(
    (listener) => listener.type === "slack" && listener.channel.startsWith("@"),
  );
}

function shadowAutomationsOf(listing: RemoteList): Map<string, RemoteAutomation> {
  return new Map(
    listing.workflows.flatMap((row) => {
      const automation = row.workflow;
      return !automation?.description?.startsWith(SLATE_SHADOW_MARKER_PREFIX)
        ? []
        : [[automation.automationId, automation] as const];
    }),
  );
}

function enabledRemoteAutomationIds(listing: RemoteList): Set<string> {
  return new Set(
    listing.workflows.flatMap((row) => {
      const automation = row.workflow;
      return automation?.enabled ? [automation.automationId] : [];
    }),
  );
}

function idsMatch(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size !== right.size) return false;
  for (const id of left) if (!right.has(id)) return false;
  return true;
}

function authorityMatches(
  left: SchedulingAuthority | undefined,
  right: SchedulingAuthority,
): boolean {
  return left !== undefined
    && idsMatch(left.wantedAutomationIds, right.wantedAutomationIds)
    && idsMatch(left.enabledRemoteAutomationIds, right.enabledRemoteAutomationIds);
}

function convergedWith(
  upstreamById: ReadonlyMap<string, RemoteAutomation>,
  desiredByAutomationId: ReadonlyMap<string, CloudDefinition>,
): boolean {
  if (upstreamById.size !== desiredByAutomationId.size) return false;
  for (const [automationId, wanted] of desiredByAutomationId) {
    const upstream = upstreamById.get(automationId);
    if (upstream === undefined || upstream.description !== wanted.marker || upstream.enabled !== wanted.enabled) return false;
  }
  return true;
}

function errorShape(error: unknown): { errorType: string; errorCode?: string } {
  const errorType = error instanceof Error ? error.constructor.name : typeof error;
  const errorCode = error instanceof ConnectError ? Code[error.code] : findSystemErrno(error);
  return errorCode === undefined ? { errorType } : { errorType, errorCode };
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

export function cloudTriggers(trigger: AutomationTrigger, timeZone?: string | undefined): BackendCloudTrigger[] | null {
  if (triggerListeners(trigger).some((listener) => listener.type === "slack" && listener.channel.startsWith("@"))) return null;
  return [
    ...triggerCronSchedules(trigger).map((schedule) => buildCronTrigger({ schedule, timeZone })),
    ...triggersForListeners(triggerEventTriggers(trigger)),
  ];
}

export interface CloudDefinition {
  readonly automationId: string;
  readonly enabled: boolean;
  readonly hash: string;
  readonly localId: string;
  readonly marker: string;
  readonly name: string;
  readonly workflow: Workflow;
}

export function slateCloudDefinition(args: { agentId: string; automation: ScheduledCloudAutomation; timeZone?: string | undefined }): CloudDefinition | null {
  const triggerList = cloudTriggers(args.automation.trigger, args.timeZone);
  if (triggerList === null) return null;
  const workflow = new Workflow({ triggers: [...triggerList] as Trigger[], prompts: [new Prompt({ prompt: args.automation.prompt })] });
  const githubSubscriptionVersion = workflow.triggers.some((trigger) => trigger.trigger?.case === "git") ? "github-subscriptions-v1\0" : "";
  const hashPrefix = Buffer.from(`${githubSubscriptionVersion}${args.automation.id}\0${args.automation.name}\0${String(args.automation.isEnabled)}\0`);
  const hash = sha256Hex(Buffer.concat([hashPrefix, Buffer.from(workflow.toBinary())]));
  return {
    automationId: stableAutomationId({ agentId: args.agentId, localId: args.automation.id }),
    enabled: args.automation.isEnabled && isServerSchedulable(args.automation),
    hash,
    localId: args.automation.id,
    marker: `${SLATE_SHADOW_MARKER_PREFIX}${hash}`,
    name: args.automation.name,
    workflow,
  };
}

export interface RemoteAutomation {
  readonly automationId: string;
  readonly description?: string;
  readonly enabled: boolean;
}
interface RemoteList { readonly workflows: readonly { readonly workflow?: RemoteAutomation }[] }
export interface CloudSyncClient {
  listSlateAutomations(request: ListSlateAutomationsRequest): Promise<RemoteList>;
  createSlateAutomation(request: CreateAutomationRequest): Promise<unknown>;
  updateSlateAutomation(request: UpdateAutomationRequest): Promise<unknown>;
  deleteSlateAutomation(request: DeleteAutomationRequest): Promise<unknown>;
}
interface SchedulingEvidence { readonly kind: "known"; readonly enabledRemoteAutomationIds: Set<string> }
interface UnknownSchedulingEvidence { readonly kind: "unknown" }
type AnySchedulingEvidence = SchedulingEvidence | UnknownSchedulingEvidence;
interface SchedulingAuthority { readonly wantedAutomationIds: Set<string>; readonly enabledRemoteAutomationIds: Set<string> }

export class SlateAutomationCloudSync {
  private running: Promise<void> | undefined;
  private rerunRequested = false;
  private readonly fingerprints = new Map<string, string>();
  private readonly evidenceByAgent = new Map<string, AnySchedulingEvidence>();
  private readonly publishedAuthority = new Map<string, SchedulingAuthority>();
  private readonly failedAgentIds = new Set<string>();
  private readonly deletionsToRetry = new Set<string>();
  private timeSettings: { getUserTimeZone: () => string | undefined };

  constructor(private readonly deps: {
    readonly client: CloudSyncClient;
    readonly hasCredential: () => boolean;
    readonly listAgentIds: () => Promise<readonly string[]>;
    readonly listAutomations: () => Promise<readonly { agentId: string; automation: ScheduledCloudAutomation }[]>;
    readonly getTimeZone?: () => string | undefined;
    readonly inspectLocalDefinitions?: (agentId: string) => { state?: string; validDefinitionCount?: number } | undefined;
    readonly reportShadowPrune?: (report: Record<string, unknown>) => void;
    readonly onFailure: (problem: { agentId?: string; operation: string; error: unknown }) => void;
    readonly onRecovery: (agentId: string) => void;
    readonly onSchedulingAuthorityChanged: (agentId: string) => void;
    readonly reportDiagnostic?: (diagnostic: Record<string, unknown>) => void;
  }) {
    this.timeSettings = { getUserTimeZone: deps.getTimeZone ?? (() => undefined) };
  }

  setSettings(timeSettings: { getUserTimeZone: () => string | undefined }): void { this.timeSettings = timeSettings; }

  shouldScheduleLocally({ agentId, automation }: { agentId: string; automation: { readonly id?: string; readonly trigger: AutomationTrigger } }): boolean {
    if (!isServerSchedulable(automation)) return true;
    if (triggerListeners(automation.trigger).length === 0) return false;
    if (automation.id === undefined) return true;
    const evidence = this.evidenceByAgent.get(agentId);
    if (evidence?.kind !== "known") return false;
    return !evidence.enabledRemoteAutomationIds.has(stableAutomationId({ agentId, localId: automation.id }));
  }

  reconcileNow(): Promise<void> {
    if (this.running !== undefined) {
      this.rerunRequested = true;
      return this.running;
    }
    this.running = this.reconcile().catch((error) => { this.reportFailure({ operation: "reconcile", error }); }).finally(() => {
      this.running = undefined;
      if (this.rerunRequested) {
        this.rerunRequested = false;
        void this.reconcileNow();
      }
    });
    return this.running;
  }

  async deleteAgent(agentId: string): Promise<boolean> {
    this.deletionsToRetry.add(agentId);
    const before = await this.fetchRemote(agentId);
    if (before === undefined) return false;
    const remoteAutomations = before.workflows.flatMap((row) => row.workflow === undefined ? [] : [row.workflow]);
    if (remoteAutomations.length === 0) {
      this.publishEvidence(agentId, before, NO_DESIRED_CLOUD_AUTOMATION_IDS);
      this.completeDeletion(agentId);
      return true;
    }
    let someMutationFailed = false;
    for (const automation of remoteAutomations) {
      const worked = await this.attemptMutation(agentId, "delete", () => this.deps.client.deleteSlateAutomation(new DeleteAutomationRequest({ automationId: automation.automationId })));
      someMutationFailed ||= !worked;
    }
    const after = await this.fetchRemote(agentId);
    if (after === undefined) return false;
    this.publishEvidence(agentId, after, NO_DESIRED_CLOUD_AUTOMATION_IDS);
    if (after.workflows.some((row) => row.workflow !== undefined)) {
      if (!someMutationFailed) this.reportFailure({ agentId, operation: "verify", error: new Error("Remote automation deletion did not converge") });
      return false;
    }
    this.completeDeletion(agentId);
    return true;
  }

  private async retryDeletions(): Promise<void> {
    for (const agentId of [...this.deletionsToRetry]) await this.deleteAgent(agentId);
  }

  private async reconcile(): Promise<void> {
    if (!this.deps.hasCredential()) return;
    await this.retryDeletions();
    let listedAutomations: readonly { agentId: string; automation: ScheduledCloudAutomation }[];
    try { listedAutomations = await this.deps.listAutomations(); } catch (error) { this.reportFailure({ operation: "list-local", error }); return; }
    let listedAgents: readonly string[];
    try { listedAgents = await this.deps.listAgentIds(); } catch (error) { this.reportFailure({ operation: "list-agents", error }); return; }
    const agentIds = new Set(listedAgents);
    const desiredByAgent = new Map<string, Map<string, CloudDefinition>>();
    const timeZone = this.timeSettings.getUserTimeZone();
    for (const { agentId, automation } of listedAutomations) {
      agentIds.add(agentId);
      const wanted = slateCloudDefinition({ agentId, automation, timeZone });
      if (wanted === null) continue;
      const wantedById = desiredByAgent.get(agentId) ?? new Map<string, CloudDefinition>();
      wantedById.set(wanted.automationId, wanted);
      desiredByAgent.set(agentId, wantedById);
    }
    for (const agentId of agentIds) {
      const wanted = desiredByAgent.get(agentId) ?? new Map<string, CloudDefinition>();
      const stamp = [...wanted.values()].sort((a, b) => a.automationId.localeCompare(b.automationId)).map((definition) => `${definition.automationId}:${definition.marker}`).join("\0");
      if (this.fingerprints.get(agentId) === stamp) continue;
      try {
        if (await this.reconcileOne(agentId, wanted)) this.fingerprints.set(agentId, stamp);
      } catch (error) { this.reportFailure({ agentId, operation: "reconcile", error }); }
    }
  }

  private async reconcileOne(agentId: string, desiredByAutomationId: Map<string, CloudDefinition>): Promise<boolean> {
    const wantedAutomationIds = new Set(desiredByAutomationId.keys());
    const before = await this.fetchRemote(agentId);
    if (before === undefined) return false;
    const upstreamById = shadowAutomationsOf(before);
    if (convergedWith(upstreamById, desiredByAutomationId)) {
      this.publishEvidence(agentId, before, wantedAutomationIds);
      this.reportRecovery(agentId);
      return true;
    }
    let someMutationFailed = false;
    const localState = this.deps.inspectLocalDefinitions?.(agentId);
    for (const [automationId, upstream] of upstreamById) {
      if (desiredByAutomationId.has(automationId)) continue;
      const worked = await this.attemptMutation(agentId, "delete", () => this.deps.client.deleteSlateAutomation(new DeleteAutomationRequest({ automationId: upstream.automationId })));
      someMutationFailed ||= !worked;
      this.deps.reportShadowPrune?.({ conversationId: agentId, automationId, outcome: worked ? "deleted" : "failed", localDefinitionState: localState?.state ?? "unknown", localDefinitionCount: localState?.validDefinitionCount ?? desiredByAutomationId.size, desiredCount: desiredByAutomationId.size, remoteShadowCount: upstreamById.size });
    }
    for (const [automationId, wanted] of desiredByAutomationId) {
      const upstream = upstreamById.get(automationId);
      if (upstream === undefined) {
        const worked = await this.attemptMutation(agentId, "create", () => this.deps.client.createSlateAutomation(new CreateAutomationRequest({ description: wanted.marker, name: wanted.name, workflow: wanted.workflow, enabled: wanted.enabled, slateAgentId: agentId, slateAutomationId: automationId })));
        someMutationFailed ||= !worked;
      } else if (upstream.description !== wanted.marker || upstream.enabled !== wanted.enabled) {
        const worked = await this.attemptMutation(agentId, "update", () => this.update(upstream.automationId, wanted));
        someMutationFailed ||= !worked;
      }
    }
    const after = await this.fetchRemote(agentId);
    if (after === undefined) return false;
    this.publishEvidence(agentId, after, wantedAutomationIds);
    const matches = convergedWith(shadowAutomationsOf(after), desiredByAutomationId);
    if (!matches) {
      if (!someMutationFailed) this.reportFailure({ agentId, operation: "verify", error: new Error("Remote automation reconciliation did not converge") });
      return false;
    }
    this.reportRecovery(agentId);
    return true;
  }

  private async update(automationId: string, wanted: CloudDefinition): Promise<void> {
    await this.deps.client.updateSlateAutomation(new UpdateAutomationRequest({ automationId, description: wanted.marker, name: wanted.name, workflow: wanted.workflow, enabled: wanted.enabled }));
  }

  private async fetchRemote(agentId: string): Promise<RemoteList | undefined> {
    try { return await this.deps.client.listSlateAutomations(new ListSlateAutomationsRequest({ slateAgentId: agentId })); }
    catch (error) { this.reportFailure({ agentId, operation: "list-remote", error }); return undefined; }
  }

  private async attemptMutation(agentId: string, operation: string, work: () => Promise<unknown>): Promise<boolean> {
    this.evidenceByAgent.set(agentId, { kind: "unknown" });
    try { await work(); return true; }
    catch (error) { this.reportFailure({ agentId, operation, error }); return false; }
  }

  private publishEvidence(agentId: string, listing: RemoteList, wantedAutomationIds: Set<string>): void {
    const enabledRemoteIds = enabledRemoteAutomationIds(listing);
    this.evidenceByAgent.set(agentId, { kind: "known", enabledRemoteAutomationIds: enabledRemoteIds });
    const schedulingAuthority = { wantedAutomationIds, enabledRemoteAutomationIds: enabledRemoteIds };
    const lastPublished = this.publishedAuthority.get(agentId);
    if (authorityMatches(lastPublished, schedulingAuthority)) return;
    this.publishedAuthority.set(agentId, schedulingAuthority);
    try { this.deps.onSchedulingAuthorityChanged(agentId); }
    catch (error) { this.reportCallbackError("onSchedulingAuthorityChanged", agentId, error); }
  }

  private reportFailure(problem: { agentId?: string; operation: string; error: unknown }): void {
    if (problem.agentId !== undefined) this.failedAgentIds.add(problem.agentId);
    this.deps.reportDiagnostic?.({ extension: "automation_cloud_sync", operation: problem.operation, agentId: problem.agentId, ...errorShape(problem.error) });
    if (!this.deps.hasCredential()) return;
    try { this.deps.onFailure(problem); }
    catch (error) { this.reportCallbackError("onFailure", problem.agentId, error); }
  }

  private reportRecovery(agentId: string): void {
    if (!this.failedAgentIds.delete(agentId)) return;
    try { this.deps.onRecovery(agentId); }
    catch (error) { this.reportCallbackError("onRecovery", agentId, error); }
  }

  private completeDeletion(agentId: string): void {
    this.deletionsToRetry.delete(agentId);
    this.fingerprints.delete(agentId);
    this.reportRecovery(agentId);
    this.evidenceByAgent.delete(agentId);
    this.publishedAuthority.delete(agentId);
  }

  private reportCallbackError(callback: string, agentId: string | undefined, error: unknown): void {
    this.deps.reportDiagnostic?.({ extension: "automation_cloud_sync", operation: callback, agentId, ...errorShape(error) });
  }
}
