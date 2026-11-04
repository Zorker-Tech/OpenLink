/**
 * Keeping automations in step with where they may be scheduled: the triggers that can be translated, how a definition is
 * hashed, what the sync creates, updates and prunes, when it keeps scheduling locally, and what it reports.
 */

import assert from "node:assert/strict";
import { ConnectError, Code } from "@connectrpc/connect";
import { describe, it } from "node:test";

import {
  SLATE_SHADOW_MARKER_PREFIX,
  SlateAutomationCloudSync,
  isServerSchedulable,
  slateCloudDefinition,
  type CloudSyncClient,
  type CreateAutomationInput,
  type ScheduledCloudAutomation,
  type UpdateAutomationInput,
} from "../../source/host/automations/slate-automation-cloud-sync.ts";
import { stableAutomationId } from "../../source/host/automations/automation-id.ts";
import type { AutomationTrigger, AutomationTriggerMember, GithubTrigger, SlackTrigger } from "../../source/shared/automations.ts";
import { cloudTriggersForInterop as cloudTriggers } from "../../source/adapters/interop/automation/automation-cloud-definition-adapter.ts";
import { Prompt, Trigger, Workflow } from "../../source/adapters/interop/proto/generated/aiserver/v1/automations_pb.ts";
import { sha256Hex } from "../../source/host/sha256.ts";

type Call = { name: string; args: unknown[] };

const cron = (schedule: string): AutomationTriggerMember => ({ type: "cron", schedule });
const slack = (channel: string, match: SlackTrigger["match"]): AutomationTriggerMember => ({ type: "slack", channel, match });
const github = (repo: string, events: string[], extra: Partial<GithubTrigger> = {}): AutomationTriggerMember => ({ type: "github", repo, events, ...extra });
const automationOf = (overrides: Partial<ScheduledCloudAutomation> = {}): ScheduledCloudAutomation => ({
  id: "auto-1",
  name: "Morning report",
  prompt: "Write the morning report.",
  isEnabled: true,
  trigger: cron("0 9 * * *"),
  ...overrides,
});

/** What a backendCloudTrigger's message holds, read as the proto the sync builds. */
const casesOf = (triggers: readonly { readonly trigger: { readonly case?: string } }[] | null): Array<string | undefined> =>
  (triggers ?? []).map((trigger) => trigger.trigger.case);
const valuesOf = <T>(triggers: readonly { readonly trigger: { readonly value?: unknown } }[] | null): T[] =>
  (triggers ?? []).map((trigger) => trigger.trigger.value as T);

/** A cloud that keeps its own shadow automations, so a readback shows whether a mutation landed. */
function syncWorld(
  options: {
    hasCredential?: boolean;
    agentIds?: string[];
    automations?: Array<{ agentId: string; automation: ScheduledCloudAutomation }>;
    remote?: Record<string, Array<{ automationId: string; description?: string; enabled: boolean }>>;
    updateIsNoop?: boolean;
    deleteIsNoop?: boolean;
    failOperations?: string[];
    listFailures?: number;
    listError?: Error;
    listFailAfter?: number;
    timeZone?: string;
    inspect?: (agentId: string) => { state?: string; validDefinitionCount?: number } | undefined;
    callbacksThrow?: boolean;
    diagnosticThrows?: boolean;
  } = {},
) {
  const calls: Call[] = [];
  const record = (name: string, ...args: unknown[]) => {
    calls.push({ name, args });
  };
  const remote = new Map<string, Array<{ automationId: string; description?: string; enabled: boolean }>>(
    Object.entries(options.remote ?? {}).map(([agentId, entries]) => [agentId, [...entries]]),
  );
  let listFailures = options.listFailures ?? 0;
  let listCalls = 0;
  const client: CloudSyncClient & { remote: typeof remote } = {
    remote,
    listAutomationsForAgent: async (request: { agentId: string }) => {
      record("listRemote", request.agentId);
      listCalls += 1;
      if (options.listFailAfter !== undefined && listCalls > options.listFailAfter) throw options.listError ?? new Error("list failed");
      if (listFailures > 0) {
        listFailures -= 1;
        throw options.listError ?? new Error("list failed");
      }
      return { automations: (remote.get(request.agentId) ?? []).map((automation) => ({ id: automation.automationId, enabled: automation.enabled, ...(automation.description === undefined ? {} : { description: automation.description }) })) };
    },
    createAutomation: async (request: CreateAutomationInput) => {
      record("create", request);
      if (options.failOperations?.includes("create") === true) throw new Error("create failed");
      const entries = remote.get(request.agentId) ?? [];
      entries.push({
        automationId: request.automationId,
        enabled: request.enabled === true,
        ...(request.description === undefined ? {} : { description: request.description }),
      });
      remote.set(request.agentId, entries);
    },
    updateAutomation: async (request: UpdateAutomationInput) => {
      record("update", request);
      if (options.failOperations?.includes("update") === true) throw new Error("update failed");
      if (options.updateIsNoop === true) return;
      const entry = [...remote.values()].flat().find((candidate) => candidate.automationId === request.id);
      if (entry != null) {
        if (request.description === undefined) delete entry.description;
        else entry.description = request.description;
        entry.enabled = request.enabled === true;
      }
    },
    deleteAutomation: async (request: { readonly id: string }) => {
      record("delete", request);
      if (options.failOperations?.includes("delete") === true) throw new Error("delete failed");
      if (options.deleteIsNoop === true) return;
      for (const [agentId, entries] of remote)
        remote.set(agentId, entries.filter((entry) => entry.automationId !== request.id));
    },
  };
  const failures: unknown[] = [];
  const recoveries: string[] = [];
  const authorities: string[] = [];
  const diagnostics: unknown[] = [];
  const prunes: unknown[] = [];
  const throwIfAsked = () => {
    if (options.callbacksThrow === true) throw new Error("callback failed");
  };
  const sync = new SlateAutomationCloudSync({
    client,
    hasCredential: () => options.hasCredential !== false,
    listAgentIds: async () => {
      record("listAgents");
      return options.agentIds ?? [];
    },
    listAutomations: async () => {
      record("listAutomations");
      return options.automations ?? [];
    },
    ...(options.timeZone === undefined ? {} : { getTimeZone: () => options.timeZone }),
    ...(options.inspect === undefined ? {} : { inspectLocalDefinitions: options.inspect }),
    reportShadowPrune: (report: Record<string, unknown>) => {
      prunes.push(report);
      throwIfAsked();
    },
    onFailure: (failure: unknown) => {
      failures.push(failure);
      throwIfAsked();
    },
    onRecovery: (agentId: string) => {
      recoveries.push(agentId);
      throwIfAsked();
    },
    onSchedulingAuthorityChanged: (agentId: string) => {
      authorities.push(agentId);
      throwIfAsked();
    },
    reportDiagnostic: (diagnostic: Record<string, unknown>) => {
      diagnostics.push(diagnostic);
      if (options.diagnosticThrows === true) throw new Error("no diagnostics");
    },
  });
  return {
    sync, client, remote, calls, failures, recoveries, authorities, diagnostics, prunes,
    named: (name: string) => calls.filter((call) => call.name === name),
  };
}

describe("which automations can be scheduled elsewhere", () => {
  it("leaves a direct-message listener to the machine it runs on", () => {
    assert.equal(isServerSchedulable({ trigger: slack("@someone", { kind: "mention" }) }), false);
    assert.equal(isServerSchedulable({ trigger: slack("C123", { kind: "mention" }) }), true);
    assert.equal(isServerSchedulable({ trigger: cron("@daily") }), true);
    assert.equal(cloudTriggers(slack("@someone", { kind: "mention" })), null);
  });

  it("translates a schedule, with the zone the caller knows", () => {
    const plain = cloudTriggers(cron("0 9 * * *"));
    assert.deepEqual(casesOf(plain), ["cron"]);
    assert.deepEqual(valuesOf<{ cron: string }>(plain).map((value) => value.cron), ["0 9 * * *"]);
    // An alias is written out, and a zone pins itself into the expression.
    assert.deepEqual(valuesOf<{ cron: string }>(cloudTriggers(cron("@daily"))).map((value) => value.cron), ["0 0 * * *"]);
    assert.deepEqual(valuesOf<{ cron: string }>(cloudTriggers(cron("0 9 * * *"), "Europe/Berlin")).map((value) => value.cron), ["CRON_TZ=Europe/Berlin 0 9 * * *"]);
    // A zone pinned in the schedule wins over the caller's, and an interval is left without one.
    assert.deepEqual(valuesOf<{ cron: string }>(cloudTriggers(cron("CRON_TZ=Asia/Tokyo 0 9 * * *"), "Europe/Berlin")).map((value) => value.cron), ["CRON_TZ=Asia/Tokyo 0 9 * * *"]);
    assert.deepEqual(valuesOf<{ cron: string }>(cloudTriggers(cron("@every 15m"), "Europe/Berlin")).map((value) => value.cron), ["@every 15m"]);
  });

  it("translates what a Slack listener is waiting for", () => {
    const mention = cloudTriggers(slack("C123", { kind: "mention" }));
    assert.deepEqual(casesOf(mention), ["slackMention"]);
    assert.deepEqual(valuesOf<{ channels: string[] }>(mention).map((value) => value.channels), [["C123"]]);
    const keyword = cloudTriggers(slack("C1", { kind: "keyword", keyword: "deploy" }));
    assert.deepEqual(valuesOf<{ messageContains: string; topLevelOnly: boolean }>(keyword).map((value) => [value.messageContains, value.topLevelOnly]), [["deploy", false]]);
    const message = cloudTriggers(slack("C1", { kind: "message" }));
    assert.deepEqual(valuesOf<{ messageContains: string }>(message).map((value) => value.messageContains), [""]);
    assert.deepEqual(valuesOf<{ topLevelOnly: boolean }>(message).map((value) => value.topLevelOnly), [false]);
    // Any reaction is one trigger; named ones are one trigger per emoji, keeping who reacted.
    const anyReaction = cloudTriggers(slack("C1", { kind: "reaction", bySelf: true }));
    assert.deepEqual(casesOf(anyReaction), ["slackAnyReactionAdded"]);
    assert.deepEqual(valuesOf<{ onlyOwnerReactions: boolean }>(anyReaction).map((value) => value.onlyOwnerReactions), [true]);
    const named = cloudTriggers(slack("C1", { kind: "reaction", emoji: ["tada", "eyes"] }));
    assert.deepEqual(casesOf(named), ["slackReactionAdded", "slackReactionAdded"]);
    assert.deepEqual(valuesOf<{ emojiName: string }>(named).map((value) => value.emojiName), ["tada", "eyes"]);
  });

  it("translates the repository events a listener watches", () => {
    const pr = cloudTriggers(github("owner/repo", ["pr-opened", "pr-pushed", "pr-merged", "pr-comment"], { userAllowlist: ["octocat"] }));
    assert.deepEqual(casesOf(pr), ["git", "git", "git", "git"]);
    const values = valuesOf<{ event: { case?: string; value?: { repos: string[]; prAction?: number } }; userAllowlist: string[] }>(pr);
    assert.deepEqual(values.map((value) => value.event.value?.prAction), [1, 2, 3, 4]);
    assert.deepEqual(values[0]?.event.value?.repos, ["https://github.com/owner/repo"]);
    assert.deepEqual(values[0]?.userAllowlist, ["octocat"]);
    const reviews = cloudTriggers(github("o/r", ["review-requested", "review-approved", "review-changes-requested", "review-commented", "inline-review-comment", "review-thread-resolved", "review-thread-unresolved", "issue-assigned"]));
    assert.deepEqual(casesOf(reviews).length, 8);
    const reviewValues = valuesOf<{ event: { case?: string; value?: Record<string, unknown> } }>(reviews);
    assert.deepEqual(reviewValues.map((value) => value.event.case), ["pullRequestReviewRequested", "pullRequestReview", "pullRequestReview", "pullRequestReview", "pullRequestReviewComment", "reviewThread", "reviewThread", "issueAssigned"]);
    assert.deepEqual(reviewValues.slice(1, 4).map((value) => [value.event.value?.onApproved === true, value.event.value?.onChangesRequested === true, value.event.value?.onCommented === true]), [[true, false, false], [false, true, false], [false, false, true]]);
    // An event the platform does not know is no event at all rather than a made-up one.
    const unknown = cloudTriggers(github("o/r", ["not-a-real-event"]));
    assert.deepEqual(casesOf(unknown), ["git"]);
    assert.equal(valuesOf<{ event: { case?: string } }>(unknown)[0]?.event.case, undefined);
  });

  it("translates a CI watch only when it names a branch, and combines both kinds of event", () => {
    const both = cloudTriggers(github("o/r", ["ci-passed", "ci-failed"], { ciBranch: "main" }));
    assert.deepEqual(casesOf(both), ["git"]);
    const value = valuesOf<{ event: { case?: string; value?: { condition?: number; branch?: string; repos: string[] } } }>(both)[0];
    assert.deepEqual([value?.event.case, value?.event.value?.condition, value?.event.value?.branch, value?.event.value?.repos], ["ciCompleted", 3, "main", ["https://github.com/o/r"]]);
    assert.equal(valuesOf<{ event: { value?: { condition?: number } } }>(cloudTriggers(github("o/r", ["ci-passed"], { ciBranch: "main" })))[0]?.event.value?.condition, 2);
    assert.equal(valuesOf<{ event: { value?: { condition?: number } } }>(cloudTriggers(github("o/r", ["ci-failed"], { ciBranch: "main" })))[0]?.event.value?.condition, 1);
    // Without a branch there is nothing to watch for completion of.
    assert.deepEqual(casesOf(cloudTriggers(github("o/r", ["ci-passed"]))), []);
    // Both kinds together: the events first, then the completion watch.
    const mixed = cloudTriggers(github("o/r", ["pr-opened", "ci-failed"], { ciBranch: "main" }));
    assert.deepEqual(valuesOf<{ event: { case?: string } }>(mixed).map((value) => value.event.case), ["pullRequest", "ciCompleted"]);
  });

  it("merges several listeners of the same repository into one watch", () => {
    const merged = cloudTriggers({
      type: "group",
      listeners: [
        github("Owner/Repo", ["pr-opened"], { userAllowlist: ["octocat"] }),
        github("owner/repo", ["pr-opened", "pr-merged"], { userAllowlist: ["OCTOCAT", "hubber"] }),
      ],
    });
    // The merged watch carries the first listener's events, with the allowlists unioned without repeating a login.
    assert.deepEqual(valuesOf<{ event: { value?: { prAction?: number } }; userAllowlist: string[] }>(merged).map((value) => [value.event.value?.prAction, value.userAllowlist]), [[1, ["octocat", "hubber"]]]);
    // An unrestricted listener anywhere in the group makes the merged watch unrestricted.
    const unrestricted = cloudTriggers({ type: "group", listeners: [github("owner/repo", ["pr-opened"]), github("owner/repo", ["pr-opened"])] });
    assert.deepEqual(valuesOf<{ userAllowlist: string[] }>(unrestricted).map((value) => value.userAllowlist), [[]]);
    // CI watches merge per repository and branch, and a Slack listener in the group is kept as it is.
    const mixed = cloudTriggers({
      type: "group",
      listeners: [
        github("o/r", ["ci-passed"], { ciBranch: "main" }),
        github("o/r", ["ci-failed"], { ciBranch: "main" }),
        github("o/r", ["ci-passed"], { ciBranch: "release" }),
        slack("C1", { kind: "mention" }),
      ],
    });
    const ciValues = valuesOf<{ event: { value?: { condition?: number; branch?: string } } }>((mixed ?? []).filter((trigger) => trigger.trigger.case === "git"));
    assert.deepEqual(ciValues.map((value) => [value.event.value?.branch, value.event.value?.condition]), [["main", 3], ["release", 2]]);
    assert.deepEqual(casesOf(mixed), ["slackMention", "git", "git"]);
  });
});

describe("what a definition looks like from outside", () => {
  it("names it stably, marks it with its own hash, and carries the translated workflow", () => {
    const definition = slateCloudDefinition({ agentId: "agent-1", automation: automationOf() });
    assert.notEqual(definition, null);
    assert.equal(definition?.automationId, stableAutomationId({ agentId: "agent-1", localId: "auto-1" }));
    assert.equal(definition?.localId, "auto-1");
    assert.equal(definition?.enabled, true);
    assert.equal(definition?.marker.startsWith(SLATE_SHADOW_MARKER_PREFIX), true);
    assert.equal(definition?.marker, `${SLATE_SHADOW_MARKER_PREFIX}${definition?.hash}`);
    const definitionWorkflow = definition?.workflow as Workflow | undefined;
    assert.deepEqual(definitionWorkflow?.triggers.length, 1);
    assert.deepEqual(definitionWorkflow?.prompts.map((prompt) => prompt.prompt), ["Write the morning report."]);
    // The hash is stable for the same input, and changes when anything about the automation does.
    const same = slateCloudDefinition({ agentId: "agent-1", automation: automationOf() });
    assert.equal(same?.hash, definition?.hash);
    // The hash is the wire-visible version of the automation, so it is pinned here: any change to how a definition is
    // built — the trigger, the prompt, the fields that go into the prefix — is meant to show up as a different one.
    assert.equal(definition?.hash, "1e310486d074b05b90b8afda1cb78afcc52302806e7718be1bf12ccb25b58ba2");
    for (const changed of [
      automationOf({ prompt: "Write a different report." }),
      automationOf({ name: "Evening report" }),
      automationOf({ isEnabled: false }),
      automationOf({ id: "auto-2" }),
    ]) {
      assert.notEqual(slateCloudDefinition({ agentId: "agent-1", automation: changed })?.hash, definition?.hash);
    }
    // A watch over a repository is versioned separately, so its rollout can be staged.
    const repo = slateCloudDefinition({ agentId: "agent-1", automation: automationOf({ trigger: github("o/r", ["pr-opened"]) }) });
    assert.equal(repo?.hash, "bfa33644cac906395f25df399a20308dc04136b145d18208a65c2b344fbf86fa");
    // The hash is about the automation itself, so the same one in another conversation hashes the same — while the id
    // it is filed under does not.
    assert.equal(slateCloudDefinition({ agentId: "agent-2", automation: automationOf() })?.hash, definition?.hash);
    assert.notEqual(slateCloudDefinition({ agentId: "agent-2", automation: automationOf() })?.automationId, definition?.automationId);
  });

  it("will not hand over an automation it cannot schedule elsewhere", () => {
    assert.equal(slateCloudDefinition({ agentId: "agent-1", automation: automationOf({ isEnabled: false }) })?.enabled, false);
    assert.equal(slateCloudDefinition({ agentId: "agent-1", automation: automationOf({ trigger: slack("@someone", { kind: "mention" }) }) }), null);
  });

  it("decides per conversation whether the schedule stays here", () => {
    const world1 = syncWorld();
    // A direct-message listener has to run locally whatever the backend says.
    assert.equal(world1.sync.shouldScheduleLocally({ agentId: "agent-1", automation: { id: "auto-1", trigger: slack("@someone", { kind: "mention" }) } }), true);
    // A pure schedule has nothing to listen for, so it is never scheduled locally.
    assert.equal(world1.sync.shouldScheduleLocally({ agentId: "agent-1", automation: { id: "auto-1", trigger: cron("0 9 * * *") } }), false);
    // An automation nobody has described yet stays local until the backend is known to hold it.
    const listened = { type: "slack", channel: "C123", match: { kind: "mention" } } as const;
    assert.equal(world1.sync.shouldScheduleLocally({ agentId: "agent-1", automation: { trigger: listened } }), true);
    assert.equal(world1.sync.shouldScheduleLocally({ agentId: "agent-1", automation: { id: "auto-1", trigger: listened } }), false);
    // Once the backend is known to hold it enabled, it stops running here.
    const upstream = syncWorld({ automations: [{ agentId: "agent-1", automation: automationOf({ trigger: listened }) }] });
    upstream.remote.set("agent-1", [
      { automationId: stableAutomationId({ agentId: "agent-1", localId: "auto-1" }), description: String(slateCloudDefinition({ agentId: "agent-1", automation: automationOf({ trigger: listened }) })?.marker), enabled: true },
    ]);
    return upstream.sync.reconcileNow().then(() => {
      assert.equal(upstream.sync.shouldScheduleLocally({ agentId: "agent-1", automation: { id: "auto-1", trigger: listened } }), false);
    });
  });
});

describe("reconciling what is up there", () => {
  it("does nothing without a credential, and folds a second request into the one running", async () => {
    const unauthenticated = syncWorld({ hasCredential: false, automations: [] });
    await unauthenticated.sync.reconcileNow();
    assert.equal(unauthenticated.calls.length, 0);
    const world1 = syncWorld({ automations: [{ agentId: "agent-1", automation: automationOf() }], agentIds: [] });
    let held: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      held = resolve;
    });
    world1.client.createAutomation = async (request) => {
      world1.calls.push({ name: "create", args: [request] });
      await gate;
    };
    const first = world1.sync.reconcileNow();
    const second = world1.sync.reconcileNow();
    assert.equal(first, second);
    held();
    await first;
    // The request that came in while it ran was run again afterwards, so its automation is up there now.
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(world1.named("listRemote").length >= 2, true);
    assert.equal(world1.named("create").length, 2);
  });

  it("says where a run failed, and stops at the first thing it cannot read", async () => {
    const listLocal = syncWorld();
    listLocal.sync["deps" as never] = undefined as never;
    const failing = syncWorld({ listFailures: 1 });
    failing.sync["deps" as never] = undefined as never;
    // A list of local automations that cannot be read is reported and ends the pass.
    const brokenLocal = syncWorld();
    (brokenLocal.sync as unknown as { deps: { listAutomations: () => Promise<unknown[]> } }).deps.listAutomations = async () => {
      throw new Error("local store is down");
    };
    await brokenLocal.sync.reconcileNow();
    assert.deepEqual((brokenLocal.failures[0] as { operation: string }).operation, "list-local");
    assert.equal(brokenLocal.named("listRemote").length, 0);
    // The same for the list of conversations.
    const brokenAgents = syncWorld();
    (brokenAgents.sync as unknown as { deps: { listAgentIds: () => Promise<string[]> } }).deps.listAgentIds = async () => {
      throw new Error("no roster");
    };
    await brokenAgents.sync.reconcileNow();
    assert.deepEqual((brokenAgents.failures[0] as { operation: string }).operation, "list-agents");
    assert.equal(brokenAgents.named("listRemote").length, 0);
    // A failure while reading what is up there is named for what it was.
    const brokenRemote = syncWorld({ automations: [{ agentId: "agent-1", automation: automationOf() }], listFailures: 1 });
    await brokenRemote.sync.reconcileNow();
    assert.deepEqual((brokenRemote.failures[0] as { operation: string; agentId: string }).operation, "list-remote");
    assert.deepEqual((brokenRemote.failures[0] as { agentId: string }).agentId, "agent-1");
    assert.deepEqual(brokenRemote.diagnostics[0], { extension: "automation_cloud_sync", operation: "list-remote", agentId: "agent-1", errorType: "Error" });
    // A failure the system reported is named by the code the system gave it.
    const withErrno = syncWorld({ automations: [{ agentId: "agent-1", automation: automationOf() }], listFailures: 1, listError: Object.assign(new Error("permission denied"), { code: "EACCES" }) });
    await withErrno.sync.reconcileNow();
    assert.deepEqual((withErrno.diagnostics[0] as { errorCode: string }).errorCode, "EACCES");
  });

  it("creates what is missing, updates what drifted, and leaves what matches alone", async () => {
    const world1 = syncWorld({ automations: [{ agentId: "agent-1", automation: automationOf() }], agentIds: [], timeZone: "UTC" });
    await world1.sync.reconcileNow();
    const created = world1.named("create")[0]?.args[0] as CreateAutomationInput;
    const definition = slateCloudDefinition({ agentId: "agent-1", automation: automationOf(), timeZone: "UTC" });
    assert.deepEqual([created.agentId, created.automationId, created.description, created.name, created.enabled], ["agent-1", stableAutomationId({ agentId: "agent-1", localId: "auto-1" }), definition?.marker, "Morning report", true]);
    assert.deepEqual((created.workflow as Workflow | undefined)?.prompts.map((prompt) => prompt.prompt), ["Write the morning report."]);
    // A second pass has nothing left to do.
    await world1.sync.reconcileNow();
    await world1.sync.reconcileNow();
    assert.equal(world1.named("create").length, 1);
    assert.equal(world1.named("update").length, 0);
    // A remote copy that drifted is brought back in line; one that already matches is left alone.
    const id = stableAutomationId({ agentId: "agent-1", localId: "auto-1" });
    const drifted = syncWorld({ automations: [{ agentId: "agent-1", automation: automationOf() }], remote: { "agent-1": [{ automationId: id, description: `${SLATE_SHADOW_MARKER_PREFIX}an-older-hash`, enabled: true }] } });
    await drifted.sync.reconcileNow();
    const updated = drifted.named("update")[0]?.args[0] as UpdateAutomationInput;
    assert.deepEqual([drifted.named("create").length, updated.id, updated.description], [0, id, slateCloudDefinition({ agentId: "agent-1", automation: automationOf() })?.marker]);
    const disabled = syncWorld({ automations: [{ agentId: "agent-1", automation: automationOf({ isEnabled: false }) }], remote: { "agent-1": [{ automationId: id, description: String(slateCloudDefinition({ agentId: "agent-1", automation: automationOf({ isEnabled: false }) })?.marker), enabled: true }] } });
    // An entry up there that the platform did not write is not a shadow of anything, so it is left alone.
    const foreign = syncWorld({ automations: [], agentIds: ["agent-1"], remote: { "agent-1": [{ automationId: "someone-elses", description: "their own automation", enabled: true }] } });
    await foreign.sync.reconcileNow();
    assert.deepEqual([foreign.named("delete").length, foreign.prunes.length], [0, 0]);
    await disabled.sync.reconcileNow();
    assert.deepEqual((disabled.named("update")[0]?.args[0] as UpdateAutomationInput).enabled, false);
  });

  it("prunes a shadow automation nobody wants any more, and says what it knew about it", async () => {
    const stray = stableAutomationId({ agentId: "agent-1", localId: "deleted-automation" });
    const world1 = syncWorld({
      automations: [{ agentId: "agent-1", automation: automationOf() }],
      remote: { "agent-1": [{ automationId: stray, description: `${SLATE_SHADOW_MARKER_PREFIX}old`, enabled: true }] },
      inspect: () => ({ state: "ok", validDefinitionCount: 1 }),
    });
    await world1.sync.reconcileNow();
    assert.deepEqual((world1.named("delete")[0]?.args[0] as { id: string }).id, stray);
    assert.deepEqual(world1.prunes[0], {
      conversationId: "agent-1",
      automationId: stray,
      outcome: "deleted",
      localDefinitionState: "ok",
      localDefinitionCount: 1,
      desiredCount: 1,
      remoteShadowCount: 1,
    });
    // A prune that failed is reported as failed rather than deleted.
    const failing = syncWorld({ automations: [], agentIds: ["agent-1"], remote: { "agent-1": [{ automationId: stray, description: `${SLATE_SHADOW_MARKER_PREFIX}old`, enabled: true }] }, failOperations: ["delete"] });
    await failing.sync.reconcileNow();
    assert.deepEqual((failing.prunes[0] as { outcome: string }).outcome, "failed");
    assert.deepEqual(failing.failures.map((failure) => (failure as { operation: string }).operation), ["delete"]);
  });

  it("names what it is waiting for when the readback still disagrees", async () => {
    const id = stableAutomationId({ agentId: "agent-1", localId: "auto-1" });
    // The update appears to succeed but the remote never changes: that is a verification failure, reported once and
    // without inventing a mutation failure.
    const world1 = syncWorld({ automations: [{ agentId: "agent-1", automation: automationOf() }], remote: { "agent-1": [{ automationId: id, description: `${SLATE_SHADOW_MARKER_PREFIX}stale`, enabled: true }] }, updateIsNoop: true });
    await world1.sync.reconcileNow();
    assert.deepEqual(world1.failures.map((failure) => (failure as { operation: string }).operation), ["verify"]);
    // A mutation that failed is already reported as itself; the readback does not blame verification for it too.
    const deleteFailed = syncWorld({ automations: [], agentIds: ["agent-1"], remote: { "agent-1": [{ automationId: id, description: `${SLATE_SHADOW_MARKER_PREFIX}stale`, enabled: true }] }, failOperations: ["delete"] });
    await deleteFailed.sync.reconcileNow();
    assert.deepEqual(deleteFailed.failures.map((failure) => (failure as { operation: string }).operation), ["delete"]);
    // The conversation stays marked as failed and its fingerprint is not remembered, so the next pass tries again.
    await world1.sync.reconcileNow();
    assert.equal(world1.named("update").length >= 2, true);
  });

  it("publishes who holds the schedule only when that changed, and says when it recovered", async () => {
    const automations = [{ agentId: "agent-1", automation: automationOf() }];
    const world1 = syncWorld({ automations });
    await world1.sync.reconcileNow();
    assert.deepEqual(world1.authorities, ["agent-1"]);
    await world1.sync.reconcileNow();
    assert.deepEqual(world1.authorities, ["agent-1"]);
    assert.deepEqual(world1.recoveries, []);
    // A pass that does have work to do — the routine's prompt changed, so its version did — publishes the same
    // authority only once, because who holds the schedule has not changed.
    automations[0] = { agentId: "agent-1", automation: automationOf({ prompt: "Write a different report." }) };
    await world1.sync.reconcileNow();
    assert.deepEqual([world1.named("update").length, world1.authorities], [1, ["agent-1"]]);
    // A pass that fails is reported per conversation, and a later pass that works says it recovered.
    const flaky = syncWorld({ automations: [{ agentId: "agent-1", automation: automationOf() }], listFailures: 1 });
    await flaky.sync.reconcileNow();
    assert.deepEqual(flaky.failures.length, 1);
    assert.deepEqual(flaky.recoveries, []);
    await flaky.sync.reconcileNow();
    assert.deepEqual(flaky.recoveries, ["agent-1"]);
    // The authority changing again — the automation is gone, so nothing is enabled up there — is published.
    const changed = syncWorld({ automations: [{ agentId: "agent-1", automation: automationOf() }], agentIds: ["agent-1"] });
    await changed.sync.reconcileNow();
    (changed.sync as unknown as { deps: { listAutomations: () => Promise<unknown[]> } }).deps.listAutomations = async () => [];
    await changed.sync.reconcileNow();
    assert.deepEqual(changed.authorities, ["agent-1", "agent-1"]);
  });

  it("keeps a failing callback from breaking the pass", async () => {
    const world1 = syncWorld({ automations: [{ agentId: "agent-1", automation: automationOf() }], callbacksThrow: true });
    await world1.sync.reconcileNow();
    assert.equal(world1.named("create").length, 1);
    assert.equal(world1.diagnostics.length >= 1, true);
    assert.equal(world1.diagnostics.some((diagnostic) => (diagnostic as { operation: string }).operation === "onFailure"), false);
    // A diagnostic is treated as trusted rather than guarded: one that throws fails the pass it was reported from,
    // which is recorded here rather than papered over.
    const hostile = syncWorld({ automations: [{ agentId: "agent-1", automation: automationOf() }], listFailures: 1, diagnosticThrows: true });
    await assert.rejects(() => hostile.sync.reconcileNow(), /no diagnostics/);
  });
});

describe("a conversation that is going away", () => {
  it("takes its automations down with it, and only says so when they are really gone", async () => {
    const id = stableAutomationId({ agentId: "agent-1", localId: "auto-1" });
    const world1 = syncWorld({ remote: { "agent-1": [{ automationId: id, description: `${SLATE_SHADOW_MARKER_PREFIX}x`, enabled: true }] } });
    assert.equal(await world1.sync.deleteAgent("agent-1"), true);
    assert.deepEqual((world1.named("delete")[0]?.args[0] as { id: string }).id, id);
    assert.equal(world1.remote.get("agent-1")?.length, 0);
    // A conversation with nothing up there is finished immediately.
    const empty = syncWorld();
    assert.equal(await empty.sync.deleteAgent("agent-1"), true);
    assert.equal(empty.named("delete").length, 0);
    // A deletion that did not land is reported and the conversation is not finished.
    const stuck = syncWorld({ remote: { "agent-1": [{ automationId: id, description: `${SLATE_SHADOW_MARKER_PREFIX}x`, enabled: true }] }, failOperations: ["delete"] });
    assert.equal(await stuck.sync.deleteAgent("agent-1"), false);
    assert.deepEqual(stuck.failures.map((failure) => (failure as { operation: string }).operation), ["delete"]);
    const quietlyStuck = syncWorld({ remote: { "agent-1": [{ automationId: id, description: `${SLATE_SHADOW_MARKER_PREFIX}x`, enabled: true }] }, deleteIsNoop: true });
    assert.equal(await quietlyStuck.sync.deleteAgent("agent-1"), false);
    assert.deepEqual(quietlyStuck.failures.map((failure) => (failure as { operation: string }).operation), ["verify"]);
    // A conversation that cannot be read at all is left for another try.
    const unreadable = syncWorld({ listFailures: 1 });
    assert.equal(await unreadable.sync.deleteAgent("agent-1"), false);
    assert.deepEqual(unreadable.failures.map((failure) => (failure as { operation: string }).operation), ["list-remote"]);
  });

  it("remembers a deletion that could not be finished, and retries it on the next pass", async () => {
    const id = stableAutomationId({ agentId: "agent-1", localId: "auto-1" });
    const world1 = syncWorld({ remote: { "agent-1": [{ automationId: id, description: `${SLATE_SHADOW_MARKER_PREFIX}x`, enabled: true }] }, listFailures: 1 });
    assert.equal(await world1.sync.deleteAgent("agent-1"), false);
    assert.equal(world1.remote.get("agent-1")?.length, 1);
    // The next pass retries it before it does anything else.
    await world1.sync.reconcileNow();
    assert.equal(world1.remote.get("agent-1")?.length, 0);
    // A failed conversation is forgiven once its deletion really lands.
    const forgiven = syncWorld();
    (forgiven.sync as unknown as { failedAgentIds: Set<string> }).failedAgentIds.add("agent-1");
    assert.equal(await forgiven.sync.deleteAgent("agent-1"), true);
    assert.deepEqual(forgiven.recoveries, ["agent-1"]);
  });
});

describe("the definition a workflow becomes", () => {
  it("hashes a github watch with the subscription version and marks it", () => {
    const automation = automationOf({ trigger: github("o/r", ["pr-opened"]) });
    const definition = slateCloudDefinition({ agentId: "agent-1", automation });
    assert.ok(definition !== null);
    const triggers = cloudTriggers(automation.trigger);
    assert.ok(triggers !== null);
    const workflow = new Workflow({ triggers: [...triggers] as Trigger[], prompts: [new Prompt({ prompt: automation.prompt })] });
    const prefix = Buffer.from(`github-subscriptions-v1\0${automation.id}\0${automation.name}\0${String(automation.isEnabled)}\0`);
    const hash = sha256Hex(Buffer.concat([prefix, Buffer.from(workflow.toBinary())]));
    assert.equal(definition.hash, hash);
    assert.equal(definition.marker, SLATE_SHADOW_MARKER_PREFIX + hash);
  });

  it("keeps a definition enabled only when it is both on and schedulable elsewhere", () => {
    assert.equal(slateCloudDefinition({ agentId: "agent-1", automation: automationOf() })?.enabled, true);
    assert.equal(slateCloudDefinition({ agentId: "agent-1", automation: automationOf({ isEnabled: false }) })?.enabled, false);
    const directMessage = slack("@someone", { kind: "mention" });
    assert.equal(slateCloudDefinition({ agentId: "agent-1", automation: automationOf({ trigger: directMessage }) }), null);
  });
});

describe("what the sync does with several conversations", () => {
  it("creates each conversation's own automations under its own id", async () => {
    const world1 = syncWorld({
      agentIds: ["agent-1", "agent-2"],
      automations: [
        { agentId: "agent-1", automation: automationOf() },
        { agentId: "agent-2", automation: automationOf({ id: "auto-2" }) },
      ],
    });
    await world1.sync.reconcileNow();
    assert.deepEqual(world1.named("create").map((call) => (call.args[0] as { agentId?: string }).agentId).sort(), ["agent-1", "agent-2"]);
    assert.equal(world1.remote.get("agent-1")?.length, 1);
    assert.equal(world1.remote.get("agent-2")?.length, 1);
  });

  it("uses the time zone its settings name when it creates the workflow", async () => {
    const world1 = syncWorld({ automations: [{ agentId: "agent-1", automation: automationOf() }] });
    world1.sync.setSettings({ getUserTimeZone: () => "Asia/Tokyo" });
    await world1.sync.reconcileNow();
    const request = world1.named("create")[0]?.args[0] as { workflow?: Workflow };
    const workflowJson = (request.workflow?.toJson() as unknown as { triggers?: Array<{ cron?: { cron?: string } }> } | undefined);
    assert.equal(workflowJson?.triggers?.[0]?.cron?.cron, "CRON_TZ=Asia/Tokyo 0 9 * * *");
  });

  it("does not call a first success a recovery", async () => {
    const world1 = syncWorld({ automations: [{ agentId: "agent-1", automation: automationOf() }] });
    await world1.sync.reconcileNow();
    assert.deepEqual(world1.recoveries, []);
    assert.deepEqual(world1.failures, []);
  });

  it("reports a failure without a credential as a diagnostic only", async () => {
    const world1 = syncWorld({ hasCredential: false, listFailures: 1 });
    assert.equal(await world1.sync.deleteAgent("agent-1"), false);
    assert.deepEqual(world1.failures, []);
    assert.equal(world1.diagnostics.length, 1);
    assert.equal((world1.diagnostics[0] as { operation?: string }).operation, "list-remote");
  });

  it("names a callback that threw in the diagnostics", async () => {
    const world1 = syncWorld({ callbacksThrow: true, automations: [{ agentId: "agent-1", automation: automationOf() }] });
    await world1.sync.reconcileNow();
    const operations = world1.diagnostics.map((diagnostic) => (diagnostic as { operation?: string }).operation);
    assert.equal(operations.includes("onSchedulingAuthorityChanged"), true);
  });
});

describe("the rest of the trigger translations", () => {
  it("keeps the review-thread flags and the merged allowlist honest", () => {
    const threads = cloudTriggers(github("o/r", ["review-thread-resolved", "review-thread-unresolved"]));
    assert.deepEqual(valuesOf<{ event: { value?: { onResolved?: boolean; onUnresolved?: boolean } } }>(threads).map((value) => [value.event.value?.onResolved === true, value.event.value?.onUnresolved === true]), [[true, false], [false, true]]);
    const merged = cloudTriggers({ type: "group", listeners: [github("o/r", ["pr-opened"], { userAllowlist: ["a"] }), github("o/r", ["pr-opened"])] });
    assert.deepEqual(valuesOf<{ userAllowlist: string[] }>(merged).map((value) => value.userAllowlist), [[]]);
    const events = cloudTriggers({ type: "group", listeners: [github("o/r", ["pr-opened"]), github("o/r", ["pr-opened", "pr-merged"])] });
    // The merged watch carries the first listener's events; the second only adds to the allowlist.
    assert.deepEqual(valuesOf<{ event: { value?: { prAction?: number } } }>(events).map((value) => value.event.value?.prAction), [1]);
  });

  it("translates the other platforms a listener can wait on", () => {
    const worlds = [
      { type: "microsoftTeams", tenantId: "t", teamId: "team", teamIds: ["team"], channelIds: ["channel"], messageContains: "", messageContainsIsRegex: false, blockUnauthenticatedTeamsUsers: false },
      { type: "linear", projectIds: [], teamIds: [], event: { case: "issueCreated" } },
      { type: "sentry", projectIds: [], event: { case: "issueCreated" } },
      { type: "pagerduty", serviceIds: [], event: { case: "incidentAny" } },
    ];
    for (const trigger of worlds) assert.equal(cloudTriggers(trigger as never)?.length, 1);
  });
});

describe("the sync's bookkeeping", () => {
  it("publishes and remembers when a conversation is taken down", async () => {
    const world1 = syncWorld({});
    assert.equal(await world1.sync.deleteAgent("agent-1"), true);
    assert.deepEqual(world1.authorities, ["agent-1"]);
    assert.equal((world1.sync as unknown as { deletionsToRetry: Set<string> }).deletionsToRetry.size, 0);
    // A second taking down publishes again, because the first one forgot its authority.
    assert.equal(await world1.sync.deleteAgent("agent-1"), true);
    assert.deepEqual(world1.authorities, ["agent-1", "agent-1"]);
  });

  it("keeps a deletion whose readback failed, and retries it on the next pass", async () => {
    const world1 = syncWorld({ remote: { "agent-1": [{ automationId: "one", enabled: true }] }, listFailAfter: 1 });
    assert.equal(await world1.sync.deleteAgent("agent-1"), false);
    assert.equal((world1.sync as unknown as { deletionsToRetry: Set<string> }).deletionsToRetry.has("agent-1"), true);
  });

  it("forgets the stamp of a conversation it took down, so it can be built again", async () => {
    const automations = [{ agentId: "agent-1", automation: automationOf() }];
    const world1 = syncWorld({ automations });
    await world1.sync.reconcileNow();
    assert.equal(world1.remote.get("agent-1")?.length, 1);
    assert.equal(await world1.sync.deleteAgent("agent-1"), true);
    assert.equal(world1.remote.get("agent-1")?.length, 0);
    await world1.sync.reconcileNow();
    assert.equal(world1.remote.get("agent-1")?.length, 1);
    assert.equal(world1.authorities.length, 3);
  });

  it("does not rerun a conversation whose stamp did not change", async () => {
    const world1 = syncWorld({ automations: [{ agentId: "agent-1", automation: automationOf() }] });
    await world1.sync.reconcileNow();
    const callsAfterFirst = world1.named("listRemote").length;
    await world1.sync.reconcileNow();
    assert.equal(world1.named("listRemote").length, callsAfterFirst);
  });

  it("keeps the stamp stable when the same automations are listed in another order", async () => {
    const automations = [{ agentId: "agent-1", automation: automationOf() }, { agentId: "agent-1", automation: automationOf({ id: "auto-2" }) }];
    const world1 = syncWorld({ automations });
    await world1.sync.reconcileNow();
    const callsAfterFirst = world1.named("listRemote").length;
    automations.reverse();
    await world1.sync.reconcileNow();
    assert.equal(world1.named("listRemote").length, callsAfterFirst);
  });

  it("calls a conversation that converges after failing a recovery", async () => {
    const definition = slateCloudDefinition({ agentId: "agent-1", automation: automationOf() });
    assert.ok(definition !== null);
    const world1 = syncWorld({ remote: { "agent-1": [{ automationId: definition.automationId, description: definition.marker, enabled: definition.enabled }] }, automations: [{ agentId: "agent-1", automation: automationOf() }] });
    (world1.sync as unknown as { failedAgentIds: Set<string> }).failedAgentIds.add("agent-1");
    await world1.sync.reconcileNow();
    assert.deepEqual(world1.recoveries, ["agent-1"]);
  });

  it("creates a disabled definition disabled", async () => {
    const world1 = syncWorld({ automations: [{ agentId: "agent-1", automation: automationOf({ isEnabled: false }) }] });
    await world1.sync.reconcileNow();
    assert.equal((world1.named("create")[0]?.args[0] as { enabled?: boolean }).enabled, false);
  });

  it("updates a definition whose enabled flag drifted", async () => {
    const definition = slateCloudDefinition({ agentId: "agent-1", automation: automationOf() });
    assert.ok(definition !== null);
    const world1 = syncWorld({ remote: { "agent-1": [{ automationId: definition.automationId, description: definition.marker, enabled: false }] }, automations: [{ agentId: "agent-1", automation: automationOf() }] });
    await world1.sync.reconcileNow();
    assert.equal(world1.named("update").length, 1);
  });

  it("stops a pass at the first list it cannot read", async () => {
    const world1 = syncWorld({ automations: [{ agentId: "agent-1", automation: automationOf() }] });
    (world1.sync as unknown as { deps: { listAutomations: () => Promise<unknown[]> } }).deps.listAutomations = async () => { throw new Error("local failed"); };
    await world1.sync.reconcileNow();
    assert.deepEqual(world1.failures.map((failure) => (failure as { operation: string }).operation), ["list-local"]);
    const agents = syncWorld({ automations: [{ agentId: "agent-1", automation: automationOf() }] });
    (agents.sync as unknown as { deps: { listAgentIds: () => Promise<string[]> } }).deps.listAgentIds = async () => { throw new Error("agents failed"); };
    await agents.sync.reconcileNow();
    assert.deepEqual(agents.failures.map((failure) => (failure as { operation: string }).operation), ["list-agents"]);
    assert.equal(agents.named("create").length, 0);
  });

  it("does not stop at a definition it cannot translate", async () => {
    const world1 = syncWorld({ automations: [
      { agentId: "agent-1", automation: automationOf({ trigger: slack("@someone", { kind: "mention" }) }) },
      { agentId: "agent-2", automation: automationOf() },
    ] });
    await world1.sync.reconcileNow();
    assert.equal(world1.named("create").length, 1);
    assert.equal((world1.named("create")[0]?.args[0] as { agentId?: string }).agentId, "agent-2");
  });

  it("fails the pass when the readback after a create cannot be read", async () => {
    const world1 = syncWorld({ automations: [{ agentId: "agent-1", automation: automationOf() }], listFailAfter: 1 });
    await world1.sync.reconcileNow();
    assert.equal(world1.named("create").length, 1);
    assert.deepEqual(world1.failures.map((failure) => (failure as { operation: string }).operation), ["list-remote"]);
    // The failed pass did not record a stamp, so the next one tries again.
    const callsAfterFailure = world1.named("listRemote").length;
    await world1.sync.reconcileNow();
    assert.equal(world1.named("listRemote").length > callsAfterFailure, true);
  });

  it("leaves the evidence unknown when a pass failed before it could re-read", async () => {
    const automations = [{ agentId: "agent-1", automation: automationOf() }];
    const world1 = syncWorld({ automations });
    await world1.sync.reconcileNow();
    automations.push({ agentId: "agent-1", automation: automationOf({ id: "auto-2" }) });
    (world1.client as unknown as { listAutomationsForAgent: unknown }).listAutomationsForAgent = async (request: { agentId: string }) => {
      world1.calls.push({ name: "listRemote", args: [request.agentId] });
      if (world1.named("listRemote").length >= 4) throw new Error("readback failed");
      return { automations: (world1.remote.get(request.agentId) ?? []).map((automation) => ({ id: automation.automationId, enabled: automation.enabled, ...(automation.description === undefined ? {} : { description: automation.description }) })) };
    };
    await world1.sync.reconcileNow();
    assert.equal(world1.sync.shouldScheduleLocally({ agentId: "agent-1", automation: automationOf({ id: "auto-9", trigger: slack("C1", { kind: "mention" }) }) }), false);
  });

  it("knows the remote ids after a pass, so a new one still schedules locally", async () => {
    const world1 = syncWorld({ automations: [{ agentId: "agent-1", automation: automationOf() }] });
    await world1.sync.reconcileNow();
    const slackAutomation = automationOf({ trigger: slack("C1", { kind: "mention" }) });
    assert.equal(world1.sync.shouldScheduleLocally({ agentId: "agent-1", automation: { ...slackAutomation, id: "brand-new" } }), true);
    assert.equal(world1.sync.shouldScheduleLocally({ agentId: "agent-1", automation: slackAutomation }), false);
  });

  it("publishes the authority again when only the remote enabled set changed", async () => {
    const automation = automationOf();
    const automations = [{ agentId: "agent-1", automation }];
    const world1 = syncWorld({ automations });
    (world1.client as unknown as { updateAutomation: (request: Record<string, unknown>) => Promise<void> }).updateAutomation = async (request) => {
      world1.calls.push({ name: "update", args: [request] });
      for (const entries of world1.remote.values()) {
        const entry = entries.find((candidate) => candidate.automationId === request.id);
        if (entry != null) entry.enabled = request.enabled === true;
      }
    };
    await world1.sync.reconcileNow();
    assert.deepEqual(world1.authorities, ["agent-1"]);
    (automation as { isEnabled: boolean }).isEnabled = false;
    await world1.sync.reconcileNow();
    assert.deepEqual(world1.authorities, ["agent-1", "agent-1"]);
  });

  it("keeps a definition that is not convolved from being called a success", async () => {
    const definition = slateCloudDefinition({ agentId: "agent-1", automation: automationOf() });
    assert.ok(definition !== null);
    const world1 = syncWorld({ remote: { "agent-1": [{ automationId: definition.automationId, description: definition.marker, enabled: definition.enabled }] }, automations: [{ agentId: "agent-1", automation: automationOf() }] });
    (world1.client as unknown as { listAutomationsForAgent: unknown }).listAutomationsForAgent = async (request: { agentId: string }) => ({ automations: (world1.remote.get(request.agentId) ?? []).map((automation) => ({ id: automation.automationId, enabled: automation.enabled, description: "stale" })) });
    await world1.sync.reconcileNow();
    assert.deepEqual(world1.failures.map((failure) => (failure as { operation: string }).operation), ["verify"]);
  });
});

describe("the rest of the sync's edges", () => {
  it("reports a ConnectError's code and leaves a plain error without one", async () => {
    const connectWorld = syncWorld({ automations: [{ agentId: "agent-1", automation: automationOf() }] });
    (connectWorld.sync as unknown as { deps: { listAutomations: () => Promise<unknown[]> } }).deps.listAutomations = async () => { throw new ConnectError("unavailable", Code.Unavailable); };
    await connectWorld.sync.reconcileNow();
    assert.equal((connectWorld.diagnostics[0] as { errorCode?: string }).errorCode, "Unavailable");
    assert.equal((connectWorld.diagnostics[0] as { errorType?: string }).errorType, "ConnectError");
    const plain = syncWorld({ automations: [{ agentId: "agent-1", automation: automationOf() }] });
    (plain.sync as unknown as { deps: { listAutomations: () => Promise<unknown[]> } }).deps.listAutomations = async () => { throw new Error("plain"); };
    await plain.sync.reconcileNow();
    assert.equal((plain.diagnostics[0] as { errorCode?: string }).errorCode, undefined);
  });

  it("copies the allowlist it was given", () => {
    const allowlist = ["octocat"];
    const listener = github("o/r", ["pr-opened"], { userAllowlist: allowlist });
    const triggers = cloudTriggers(listener);
    allowlist.push("latecomer");
    assert.deepEqual(valuesOf<{ userAllowlist: string[] }>(triggers).map((value) => value.userAllowlist), [["octocat"]]);
  });

  it("keeps an automation with no listeners here, even when it knows the remote ids", async () => {
    const world1 = syncWorld({ automations: [{ agentId: "agent-1", automation: automationOf({ isEnabled: false }) }] });
    await world1.sync.reconcileNow();
    assert.equal(world1.sync.shouldScheduleLocally({ agentId: "agent-1", automation: automationOf({ isEnabled: false }) }), false);
  });

  it("publishes a changed requested set even when the remote enabled set stayed empty", async () => {
    const automations = [{ agentId: "agent-1", automation: automationOf({ isEnabled: false }) }];
    const world1 = syncWorld({ automations });
    await world1.sync.reconcileNow();
    assert.deepEqual(world1.authorities, ["agent-1"]);
    // Same enabled set (empty), but another requested id replaces the old one.
    automations[0] = { agentId: "agent-1", automation: automationOf({ id: "auto-2", isEnabled: false }) };
    await world1.sync.reconcileNow();
    assert.deepEqual(world1.authorities, ["agent-1", "agent-1"]);
    // And a requested set that only grew is also a change.
    automations.push({ agentId: "agent-1", automation: automationOf({ id: "auto-3", isEnabled: false }) });
    await world1.sync.reconcileNow();
    assert.deepEqual(world1.authorities, ["agent-1", "agent-1", "agent-1"]);
  });

  it("forgets the deletion bookkeeping when a taking down really finished", async () => {
    const world1 = syncWorld({ remote: { "agent-1": [{ automationId: "one", enabled: true }] } });
    assert.equal(await world1.sync.deleteAgent("agent-1"), true);
    assert.equal((world1.sync as unknown as { deletionsToRetry: Set<string> }).deletionsToRetry.size, 0);
    // The evidence is gone too, so a new decision must not come from it.
    assert.equal(world1.sync.shouldScheduleLocally({ agentId: "agent-1", automation: automationOf({ id: "auto-1", trigger: slack("C1", { kind: "mention" }) }) }), false);
  });
});
