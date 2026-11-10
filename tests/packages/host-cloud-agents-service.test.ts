/**
 * The cloud agents a host runs on someone else's machines: how a run's words are read, what a launch composes, what
 * each read answers, and what a failure leaves alone.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildTranscriptJsonl,
  cloudAgentUrl,
  CLOUD_AGENT_REQUEST_SOURCE,
  MAX_CLOUD_AGENT_FILES,
  mapProtoPrStatus,
  mapRunStatus,
  normalizeDiffPath,
  resolveBranchName,
  resolvePr,
  resolvePrUrl,
  SlateCloudAgentManager,
  toFileChange,
  type CloudAgentClient,
  type DashboardClient,
} from "../../source/host/cloud-agents/cloud-agents-service.ts";
import { SlateCloudAgentLaunchError } from "../../source/host/cloud-agents/cloud-agent-launch-error.ts";

const composer = (overrides: Record<string, unknown> = {}) => ({ composer: { bcId: "bc-1", status: 2, name: "A run", branchName: "feat/x", prUrl: "https://pr.test/1", filesChanged: 2, linesAdded: 10, linesRemoved: 4, ...overrides } });

function managerWorld(options: { info?: unknown; infoFails?: unknown; teams?: readonly { id: number; name: string; isDirectMember: boolean }[]; composers?: readonly Record<string, unknown>[]; conversation?: unknown; diffs?: readonly { from: string; to: string; added: number; removed: number }[]; prState?: Record<string, unknown> | "fails"; artifacts?: readonly { absolutePath: string; sizeBytes: number | bigint }[] } = {}) {
  const calls: { name: string; args: unknown }[] = [];
  const client = {
    startBackgroundComposerFromSnapshot: async (request: unknown) => (calls.push({ name: "start", args: request }), { composer: { bcId: "bc-named" } }),
    getBackgroundComposerInfo: async (request: Record<string, unknown>) => {
      calls.push({ name: "info", args: request });
      if (options.infoFails !== undefined) throw options.infoFails;
      return options.info ?? { composer: composer() };
    },
    listBackgroundComposers: async (request: unknown) => (calls.push({ name: "list", args: request }), { composers: options.composers ?? [] }),
    addAsyncFollowupBackgroundComposer: async (request: Record<string, unknown>) => (calls.push({ name: "followup", args: request }), { runId: "run-1" }),
    pauseBackgroundComposer: async (request: unknown) => void calls.push({ name: "pause", args: request }),
    renameBackgroundComposer: async (request: unknown) => void calls.push({ name: "rename", args: request }),
    archiveBackgroundComposer: async (request: unknown) => void calls.push({ name: "archive", args: request }),
    deleteBackgroundComposer: async (request: unknown) => void calls.push({ name: "delete", args: request }),
    listBackgroundComposerArtifacts: async (request: unknown) => (calls.push({ name: "artifacts", args: request }), { artifacts: options.artifacts ?? [] }),
    getBackgroundComposerConversation: async (request: unknown) => (calls.push({ name: "conversation", args: request }), { conversation: options.conversation ?? { messages: ["one"] } }),
    getPullRequestMergeStatus: async (request: unknown) => {
      calls.push({ name: "pr", args: request });
      if (options.prState === "fails") throw new Error("the host is down");
      return options.prState ?? {};
    },
    getOptimizedDiffDetails: async (request: unknown) => (calls.push({ name: "diffs", args: request }), { diff: { diffs: options.diffs ?? [] } }),
    getEnvironment: async () => ({}),
    listEnvironments: async () => ({ environments: [] }),
  } as unknown as CloudAgentClient;
  const dashboard = {
    getTeamAdminSettingsOrEmptyIfNotInTeam: async () => ({ backgroundAgentSettings: {} }),
    getTeams: async () => ({ teams: options.teams ?? [{ id: 7, name: "Seven", isDirectMember: true }] }),
  } as unknown as DashboardClient;
  const manager = new SlateCloudAgentManager({
    getAccessToken: async () => "token",
    getMachineId: async () => "machine-1",
    completionPolling: { start: () => ({ dispose: () => {} }) },
    clock: { monotonicNow: () => 0 },
    convertConversationMessagesToTrace: (conversation) => (conversation as { messages: readonly unknown[] }).messages,
    clientForTesting: client,
    dashboardClientForTesting: dashboard,
    // The catalog is handed in rather than fetched, so no test reaches the network for it.
    modelCatalogForTesting: [{ id: "model-one" } as never],
  });
  return { manager, calls, named: (name: string) => calls.filter((call) => call.name === name) };
}

describe("how a run's own words are read", () => {
  it("names the statuses it knows, and calls everything else unknown", () => {
    assert.deepEqual([1, 2, 3, 4, 5, 6].map((status) => mapRunStatus(status)), ["running", "finished", "error", "creating", "expired", "unknown"]);
    assert.deepEqual(["running", "FINISHED", "something else", 0].map((status) => mapRunStatus(status)), ["running", "finished", "unknown", "unknown"]);
    assert.deepEqual([1, 2, 3, 4, 5].map((status) => mapProtoPrStatus(status)), ["open", "draft", "merged", "closed", null]);
  });

  it("takes the pull request a run named first, and says where it stands", () => {
    const withUrl = { composer: { prUrl: "https://pr.test/2" }, prs: [{ prUrl: "https://pr.test/1", pullNumber: 1 }, { prUrl: "https://pr.test/2", pullNumber: 2, prStatus: 3 }] };
    assert.deepEqual(resolvePr(withUrl as never), { state: "merged", number: 2 });
    assert.deepEqual([resolvePrUrl(withUrl as never), resolveBranchName({ composer: {}, prs: [{ branchName: "feat/y" }] } as never)], ["https://pr.test/2", "feat/y"]);
    // With no url to match, the first run that says anything about a pull request leads.
    assert.deepEqual(resolvePr({ composer: {}, prs: [{ pullNumber: 9, prStatus: 2 }] } as never), { state: "draft", number: 9 });
    // The composer's own state stands in when the pull request says nothing.
    assert.deepEqual(resolvePr({ composer: { prStatus: 1 }, prs: [{ pullNumber: 4 }] } as never), { state: "open", number: 4 });
    // A run with a pull request nobody state is one of unknown; one with none at all is none.
    assert.deepEqual([resolvePr({ composer: {}, prs: [{ prUrl: "https://pr.test/3" }] } as never), resolvePr({ composer: {} } as never), resolvePr(undefined)], [{ state: "unknown", number: null }, { state: "none", number: null }, { state: "none", number: null }]);
  });

  it("reads a diff as file changes, leaving out the side that is not there", () => {
    assert.deepEqual([normalizeDiffPath("  /dev/null "), normalizeDiffPath(" src/a.ts ")], ["", "src/a.ts"]);
    assert.deepEqual(
      [toFileChange({ from: "/dev/null", to: "src/new.ts", added: 3, removed: 0 }), toFileChange({ from: "src/gone.ts", to: "/dev/null", added: 0, removed: 5 }), toFileChange({ from: "/dev/null", to: "/dev/null", added: 0, removed: 0 })],
      [{ path: "src/new.ts", added: 3, removed: 0 }, { path: "src/gone.ts", added: 0, removed: 5 }, null],
    );
  });

  it("writes a conversation as JSONL, with the counts that are too big written as text", () => {
    const dump = buildTranscriptJsonl({ messages: [{ text: "one" }, { tokens: 12n }] }, (conversation) => (conversation as { messages: readonly unknown[] }).messages);
    assert.deepEqual(dump, { jsonl: '{"text":"one"}\n{"tokens":"12"}\n', lineCount: 2 });
    assert.deepEqual(buildTranscriptJsonl({ messages: [] }, (conversation) => (conversation as { messages: readonly unknown[] }).messages), { jsonl: "", lineCount: 0 });
    // A cloud agent is looked at on this platform's own site, not another product's.
    assert.equal(cloudAgentUrl("bc-1").endsWith("/cloud-agents/bc-1"), true);
    assert.equal(CLOUD_AGENT_REQUEST_SOURCE, "slate");
    assert.equal(MAX_CLOUD_AGENT_FILES, 300);
  });
});

describe("what each read answers", () => {
  it("launches with the repository, the model and the environment it was given, and answers with where it is", async () => {
    const world = managerWorld();
    const launched = await world.manager.launch({ prompt: "do it", repoUrl: "https://host.test/o/r.git", startingRef: "main", modelId: "slate-fast", modelParams: { effort: "low" }, title: "  A run  " });
    assert.deepEqual(launched, { agentId: "bc-named", url: cloudAgentUrl("bc-named") });
    const request = world.named("start")[0]!.args as Record<string, unknown>;
    assert.deepEqual([request.source, request.autoBranch, request.autoCreatePr, request.snapshotWorkspaceRootPath, request.returnImmediately], ["slate", true, true, "/workspace", true]);
    assert.equal(request.name, "A run");
    assert.equal(request.baseBranch, "main");
    assert.deepEqual(request.requestedModels, [{ modelId: "slate-fast", maxMode: true, parameters: [{ id: "effort", value: "low" }] }]);
    assert.deepEqual((request.devcontainerStartingPoint as Record<string, unknown>).ref, "main");
    assert.deepEqual((request.conversationAction as { action: { value: { userMessage: { text: string } } } }).action.value.userMessage.text, "do it");
    assert.equal(String(request.repoUrl).startsWith("https://host.test"), true);
  });

  it("refuses a launch a named worker cannot do, and one a saved environment cannot satisfy", async () => {
    const world = managerWorld();
    await assert.rejects(world.manager.launch({ prompt: "p", repoUrl: "https://host.test/o/r", startingRef: "main", environment: { type: "machine", name: "worker-1" } }), (error: Error) => error instanceof SlateCloudAgentLaunchError && error.message.includes("can't start from 'main'"));
    await assert.rejects(world.manager.launch({ prompt: "p", environment: { type: "cloud" } }), /'repo_url' is required to launch a cloud agent/);
    assert.deepEqual(world.named("start"), []);
  });

  it("lists what the account has, leaving archived runs out unless they were asked for", async () => {
    const world = managerWorld({
      composers: [
        { bcId: "bc-1", name: "One", status: 1, branchName: "feat/x", prUrl: "", isArchived: false, createdAtMs: 5 },
        { bcId: "bc-2", name: "Two", status: 2, isArchived: true },
      ],
    });
    assert.deepEqual((await world.manager.list()).map((entry) => [entry.agentId, entry.status, entry.url]), [["bc-1", "running", cloudAgentUrl("bc-1")]]);
    assert.deepEqual((await world.manager.list({ includeArchived: true, limit: 5 })).map((entry) => entry.agentId), ["bc-1", "bc-2"]);
    assert.deepEqual(world.named("list").map((call) => call.args), [{ n: 20 }, { n: 5 }]);
  });

  it("reads one run, with the platform's own limit message when that is why it stopped", async () => {
    const world = managerWorld({ info: { composer: composer({ filesChanged: 3, linesAdded: 5, linesRemoved: 1, error: undefined }) } });
    const detail = (await world.manager.get(" bc-1 "))!;
    assert.deepEqual([detail.agentId, detail.status, detail.branchName, detail.prUrl, detail.createdAtMs], ["bc-1", "finished", "feat/x", "https://pr.test/1", 0]);
    // A run that is not there at all is nothing, not a run with empty fields.
    assert.equal(await world.manager.get("   "), null);
    assert.equal(await managerWorld({ info: { composer: {} } }).manager.get("bc-1"), null);
  });

  it("replies with the model it was given, and interrupts only when asked", async () => {
    const world = managerWorld();
    assert.deepEqual(await world.manager.reply({ agentId: "bc-1", prompt: "more", modelId: "slate-fast" }), { runId: "run-1" });
    const followup = world.named("followup")[0]!.args as Record<string, unknown>;
    assert.deepEqual([followup.followupSource, followup.synchronous, (followup.requestedModel as { modelId: string }).modelId], ["slate", false, "slate-fast"]);
    await world.manager.reply({ agentId: "bc-1", prompt: "stop", interrupt: true });
    assert.deepEqual((world.named("followup")[1]!.args as Record<string, unknown>).requestedModel, undefined);
    assert.equal((world.named("followup")[1]!.args as Record<string, unknown>).synchronous, true);
  });

  it("cancels, renames, archives, deletes and lists artifacts with what the backend expects", async () => {
    const world = managerWorld({ artifacts: [{ absolutePath: "/out/report.md", sizeBytes: 12n }] });
    await world.manager.cancel("bc-1");
    await world.manager.rename("bc-1", "New name");
    await world.manager.setArchived("bc-1", true);
    await world.manager.setArchived("bc-1", false);
    await world.manager.delete("bc-1");
    assert.deepEqual(world.named("pause")[0]!.args, { bcId: "bc-1", source: "slate" });
    assert.deepEqual(world.named("rename")[0]!.args, { bcId: "bc-1", newName: "New name" });
    assert.deepEqual(world.named("archive").map((call) => call.args), [{ bcId: "bc-1", unarchive: false, source: "slate" }, { bcId: "bc-1", unarchive: true, source: "slate" }]);
    assert.deepEqual(world.named("delete")[0]!.args, { bcId: "bc-1" });
    assert.deepEqual(await world.manager.listArtifacts("bc-1"), [{ path: "/out/report.md", sizeBytes: 12 }]);
  });

  it("writes a transcript dump with the run's status, and never fails the dump over a status", async () => {
    const world = managerWorld({ conversation: { messages: [{ role: "user" }] }, info: { composer: composer({ status: 1 }) } });
    assert.deepEqual(await world.manager.getTranscriptDump({ agentId: " bc-1 " }), { jsonl: '{"role":"user"}\n', lineCount: 1, status: "running" });
    assert.equal(await world.manager.getTranscriptDump({ agentId: "  " }), null);
    // A status that could not be read leaves the transcript as it is, at unknown.
    const broken = managerWorld({ conversation: { messages: [] }, infoFails: new Error("the backend is down") });
    assert.deepEqual(await broken.manager.getTranscriptDump({ agentId: "bc-1" }), { jsonl: "", lineCount: 0, status: "unknown" });
  });

  it("answers a full read with the run, its pull request and the files it changed", async () => {
    const world = managerWorld({
      info: { composer: { ...composer({ status: 2, filesChanged: 2 }), prompt: { text: "do it" }, prs: [{ prUrl: "https://pr.test/1", pullNumber: 7, prStatus: 1 }] } },
      diffs: [{ from: "src/a.ts", to: "src/a.ts", added: 2, removed: 1 }, { from: "/dev/null", to: "/dev/null", added: 0, removed: 0 }],
      prState: { isDraft: true },
    });
    const info = (await world.manager.getInfo("bc-1"))!;
    assert.deepEqual([info.status, info.name, info.prompt, info.prUrl, info.prState, info.prNumber, info.filesChanged], ["finished", "A run", "do it", "https://pr.test/1", "draft", 7, 2]);
    assert.deepEqual(info.files, [{ path: "src/a.ts", added: 2, removed: 1 }]);
    // A pull request already merged is not asked about again, and one that could not be read leaves the stored state.
    assert.equal(await world.manager.fetchLivePrState("https://pr.test/1", "merged"), null);
    assert.deepEqual(await managerWorld({ prState: "fails" }).manager.fetchLivePrState("https://pr.test/1", "open"), null);
    assert.equal(await managerWorld().manager.fetchLivePrState("", "open"), null);
    // Files are only fetched when the caller wants them and the run changed any.
    const quiet = managerWorld({ info: { composer: composer({ filesChanged: 0 }) } });
    assert.deepEqual((await quiet.manager.getInfo("bc-1"))!.files, []);
    assert.deepEqual(quiet.named("diffs"), []);
    assert.deepEqual((await managerWorld({ info: { composer: composer() } }).manager.getInfo("bc-1", false))!.files, []);
  });

  it("answers nothing for a run that is not there, and rethrows anything else", async () => {
    const missing = managerWorld({ infoFails: Object.assign(new Error("not found"), { name: "ConnectError", code: 5 }) });
    assert.equal(await missing.manager.getInfo("bc-1"), null);
    const forbidden = managerWorld({ infoFails: Object.assign(new Error("forbidden"), { name: "ConnectError", code: 7 }) });
    assert.equal(await forbidden.manager.getInfo("bc-1"), null);
    const broken = managerWorld({ infoFails: Object.assign(new Error("the backend fell over"), { name: "ConnectError", code: 13 }) });
    await assert.rejects(broken.manager.getInfo("bc-1"), /the backend fell over/);
    assert.equal(await managerWorld().manager.getInfo("   "), null);
  });

  it("takes the team a private worker belongs to, or asks which one", async () => {
    const oneTeam = managerWorld({ teams: [{ id: 7, name: "Seven", isDirectMember: true }, { id: 8, name: "Not mine", isDirectMember: false }] });
    assert.equal(await oneTeam.manager.resolvePrivateWorkerTeamId({ type: "machine", name: "worker-1" }), 7);
    // A team the caller named is the answer, with no read at all.
    assert.equal(await managerWorld().manager.resolvePrivateWorkerTeamId({ type: "machine", name: "w", teamId: 3 }), 3);
    // A cloud environment, and a saved one, have no team of their own here.
    assert.deepEqual([await managerWorld().manager.resolvePrivateWorkerTeamId({ type: "cloud" }), await managerWorld().manager.resolvePrivateWorkerTeamId({ type: "environment", name: "Saved" }), await managerWorld().manager.resolvePrivateWorkerTeamId()], [undefined, undefined, undefined]);
    // An account with several teams is asked which one; an account with none cannot have a pool.
    await assert.rejects(managerWorld({ teams: [{ id: 7, name: "Seven", isDirectMember: true }, { id: 8, name: "Eight", isDirectMember: true }] }).manager.resolvePrivateWorkerTeamId({ type: "machine", name: "w" }), /multiple active teams\. Set environment\.team_id to one of: Seven \(7\), Eight \(8\)\./);
    assert.equal(await managerWorld({ teams: [] }).manager.resolvePrivateWorkerTeamId({ type: "machine", name: "w" }), undefined);
    await assert.rejects(managerWorld({ teams: [] }).manager.resolvePrivateWorkerTeamId({ type: "pool", name: "p" }), /self-hosted pool requires an active team/);
  });

  it("offers the models, the team policy and the waiting a caller may want", async () => {
    const world = managerWorld();
    // The model catalog is what it was handed; nothing is fetched for it.
    assert.deepEqual(await world.manager.listModels(), [{ id: "model-one" }]);
    assert.deepEqual([world.manager.isDisabledByTeamAdmin(), typeof world.manager.prefetchTeamAdminPolicy, typeof world.manager.dispose, typeof world.manager.awaitCompletion], [false, "function", "function", "function"]);
    assert.deepEqual([...world.manager.launchedIds], []);
  });
});
