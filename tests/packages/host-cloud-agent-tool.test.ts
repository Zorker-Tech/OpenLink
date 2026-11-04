/**
 * The cloud-agent tool and the images it is shown: what must be confirmed first, what each action answers, which
 * cloud agents this session is allowed to see, and which files an image may come from.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { ATTACHMENT_BYTE_LIMIT } from "../../source/shared/media/attachment-limits.ts";
import { getAgentAttachmentsDir } from "../../source/host/attachments/attachment-paths.ts";
import { loadCloudAgentImages, SLATE_BOX_WORKSPACE_ROOT } from "../../source/host/cloud-agents/cloud-agent-images.ts";
import {
  backendRejectionMessage,
  CANCELLED_BEFORE_CLOUD_AGENT_CALL,
  cloudAgentRuntimeDescription,
  createCloudAgentTool,
  DESTRUCTIVE_ACTIONS,
  modelCatalogLines,
  REVIEW_GATED_ACTIONS,
  repoShortName,
  requireCloudAgentField,
  runCloudAgentAction,
  SlateCloudAgentToolInputError,
  summaryLine,
  toCloudAgentEnvironment,
  validateModelSelection,
  type CloudAgentApi,
  type CloudAgentDetail,
  type CloudAgentToolArgs,
  type CloudAgentToolContext,
  type CloudAgentToolDeps,
  type CloudModelCatalogEntry,
} from "../../source/host/cloud-agents/cloud-agent-tool.ts";

const scratch = mkdtempSync(join(tmpdir(), "slate-cloud-agent-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

const catalog: CloudModelCatalogEntry[] = [
  { id: "slate-fast", displayName: "Fast", aliases: ["fast"], params: [{ id: "effort", values: [{ value: "low" }, { value: "high" }] }], incompatibilities: ["effort=high cannot be combined with fast"] },
];

const summary = (bcId: string, extra: Partial<CloudAgentDetail> = {}): CloudAgentDetail => ({ bcId, name: `agent ${bcId}`, status: "running", isArchived: false, branchName: "", prUrl: "", url: `https://cloud.test/${bcId}`, filesChanged: 0, linesAdded: 0, linesRemoved: 0, ...extra });

function toolWorld(options: { watch?: boolean; review?: (args: CloudAgentToolArgs) => { allowed: boolean; reason: string }; detail?: CloudAgentDetail | null; transcript?: { status: string; lineCount: number; jsonl: string } | null; replyFails?: unknown; renameFails?: unknown; launchFails?: unknown; models?: CloudModelCatalogEntry[]; modelsFail?: boolean; summaries?: CloudAgentDetail[]; artifacts?: readonly { path: string; sizeBytes: number }[] } = {}) {
  const calls: { name: string; args: unknown }[] = [];
  const watchCalls: { id: string; options: unknown }[] = [];
  const launchedIds = new Set<string>(options.summaries?.map((entry) => entry.bcId) ?? []);
  const api: CloudAgentApi = {
    launch: async (args) => {
      calls.push({ name: "launch", args });
      if (options.launchFails !== undefined) throw options.launchFails;
      return { bcId: "bc-new", url: "https://cloud.test/bc-new" };
    },
    list: async (args) => {
      calls.push({ name: "list", args });
      return options.summaries ?? [];
    },
    listModels: async () => {
      calls.push({ name: "listModels", args: {} });
      if (options.modelsFail === true) throw new Error("the catalog is down");
      return options.models ?? catalog;
    },
    get: async (id) => {
      calls.push({ name: "get", args: id });
      return options.detail === undefined ? summary(id) : options.detail;
    },
    getTranscriptDump: async (args) => {
      calls.push({ name: "getTranscriptDump", args });
      return options.transcript === undefined ? { status: "finished", lineCount: 2, jsonl: "line one\nline two" } : options.transcript;
    },
    reply: async (args) => {
      calls.push({ name: "reply", args });
      if (options.replyFails !== undefined) throw options.replyFails;
      return { runId: "run-1" };
    },
    rename: async (id, title) => {
      calls.push({ name: "rename", args: { id, title } });
      if (options.renameFails !== undefined) throw options.renameFails;
    },
    cancel: async (id) => void calls.push({ name: "cancel", args: id }),
    setArchived: async (id, archived) => void calls.push({ name: "setArchived", args: { id, archived } }),
    delete: async (id) => void calls.push({ name: "delete", args: id }),
    listArtifacts: async (id) => {
      calls.push({ name: "listArtifacts", args: id });
      return options.artifacts ?? [];
    },
  };
  const ctx: CloudAgentToolContext = { signal: new AbortController().signal, get: () => "quiet-origin" };
  const deps: CloudAgentToolDeps = {
    api,
    launchedIds,
    agentDir: join(scratch, "agent-1"),
    writeBoxFile: async () => {},
    toolCallId: "call-1",
    ...(options.watch === false ? {} : { watch: (id, given) => void watchCalls.push({ id, options: given }) }),
    ...(options.review === undefined ? {} : { reviewAction: async ({ args }) => options.review!(args) }),
  };
  return { deps, ctx, calls, watchCalls, launchedIds, named: (name: string) => calls.filter((call) => call.name === name) };
}

describe("which files an image may come from", () => {
  it("loads an image from the agent's own attachments, and answers with what it read", async () => {
    const dir = getAgentAttachmentsDir(join(scratch, "agent-images"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "shot.png"), "png-bytes");
    const loaded = await loadCloudAgentImages({ ctx: undefined, urls: [`file://${join(dir, "shot.png")}`], agentDir: join(scratch, "agent-images") });
    assert.equal(loaded.ok, true);
    assert.deepEqual(loaded.ok === true ? [[...loaded.images[0]!.data], loaded.images[0]!.mimeType, loaded.images[0]!.path] : [], [[..."png-bytes"].map((character) => character.charCodeAt(0)), "image/png", join(dir, "shot.png")]);
    // A directory is not an image a cloud agent can be shown, even when it is named like one.
    const folder = join(dir, "folder.png");
    mkdirSync(folder, { recursive: true });
    const asDirectory = await loadCloudAgentImages({ ctx: undefined, urls: [`file://${folder}`], agentDir: join(scratch, "agent-images") });
    assert.equal(asDirectory.ok, false);
    if (!asDirectory.ok) {
      assert.equal(asDirectory.message.includes(`file://${folder}`), true);
      assert.match(asDirectory.message, /could not be read/i);
    }
    // A file that is not there is the same answer.
    const absent = await loadCloudAgentImages({ ctx: undefined, urls: [`file://${join(dir, "gone.png")}`], agentDir: join(scratch, "agent-images") });
    assert.equal(absent.ok, false);
  });

  it("takes a box image out of the workspace, and refuses what is outside it or too large", async () => {
    const readBoxFile = async (_ctx: unknown, path: string) => new TextEncoder().encode(path);
    const inside = await loadCloudAgentImages({ ctx: undefined, urls: [`file://${SLATE_BOX_WORKSPACE_ROOT}/shot.png`], agentDir: join(scratch, "agent-box"), readBoxFile: readBoxFile as never });
    assert.deepEqual(inside.ok === true ? [inside.images[0]!.path, [...inside.images[0]!.data].length] : null, [`${SLATE_BOX_WORKSPACE_ROOT}/shot.png`, `${SLATE_BOX_WORKSPACE_ROOT}/shot.png`.length]);
    // A path that merely starts with the same letters is not inside the workspace.
    const lookalike = await loadCloudAgentImages({ ctx: undefined, urls: [`file://${SLATE_BOX_WORKSPACE_ROOT}-elsewhere/shot.png`], agentDir: join(scratch, "agent-box"), readBoxFile: readBoxFile as never });
    assert.equal(lookalike.ok, false);
    if (!lookalike.ok) {
      assert.equal(lookalike.message.includes(`file://${SLATE_BOX_WORKSPACE_ROOT}-elsewhere/shot.png`), true);
      assert.match(lookalike.message, /outside the allowed attachment locations/);
      assert.match(lookalike.message, /\/workspace/);
    }
    const outside = await loadCloudAgentImages({ ctx: undefined, urls: ["file:///etc/passwd.png"], agentDir: join(scratch, "agent-box"), readBoxFile: readBoxFile as never });
    assert.equal(outside.ok, false);
    if (!outside.ok) {
      assert.equal(outside.message.includes("file:///etc/passwd.png"), true);
      assert.match(outside.message, /outside the allowed attachment locations/);
    }
    // Nothing to read the box with is as good as a file that is not there.
    const withoutReader = await loadCloudAgentImages({ ctx: undefined, urls: [`file://${SLATE_BOX_WORKSPACE_ROOT}/shot.png`], agentDir: join(scratch, "agent-box") });
    assert.equal(withoutReader.ok, false);
    const tooLarge = await loadCloudAgentImages({ ctx: undefined, urls: [`file://${SLATE_BOX_WORKSPACE_ROOT}/shot.png`], agentDir: join(scratch, "agent-box"), readBoxFile: (async () => ({ byteLength: ATTACHMENT_BYTE_LIMIT + 1 })) as never });
    assert.deepEqual(tooLarge, { ok: false, message: `"file://${SLATE_BOX_WORKSPACE_ROOT}/shot.png" is too large to attach (max 25 MB).` });
    // A file that cannot be read, and a url that is not a file at all, are told apart from all of that.
    const unreadable = await loadCloudAgentImages({ ctx: undefined, urls: [`file://${SLATE_BOX_WORKSPACE_ROOT}/shot.png`], agentDir: join(scratch, "agent-box"), readBoxFile: (async () => { throw new Error("gone"); }) as never });
    assert.equal(unreadable.ok, false);
    if (!unreadable.ok) {
      assert.equal(unreadable.message.includes(`file://${SLATE_BOX_WORKSPACE_ROOT}/shot.png`), true);
      assert.match(unreadable.message, /could not be read/i);
    }
    const notAFileUrl = await loadCloudAgentImages({ ctx: undefined, urls: ["https://example.test/shot.png"], agentDir: join(scratch, "agent-box") });
    assert.match(String(notAFileUrl.ok === false ? notAFileUrl.message : ""), /is not a file:\/\/ url/);
    const notAnImage = await loadCloudAgentImages({ ctx: undefined, urls: [`file://${SLATE_BOX_WORKSPACE_ROOT}/notes.txt`], agentDir: join(scratch, "agent-box") });
    assert.match(String(notAnImage.ok === false ? notAnImage.message : ""), /is not a recognized image/);
  });
});

describe("what the tool says about a cloud agent's environment", () => {
  it("describes where it runs, and names the environment the way the backend does", () => {
    assert.deepEqual(
      [undefined, { type: "cloud" }, { type: "pool" }, { type: "pool", name: "team-pool" }, { type: "machine", name: "worker-1" }, { type: "environment", name: "Saved" }, { type: "environment", id: "env-1" }].map((environment) => cloudAgentRuntimeDescription(environment as never)),
      ["a Slate cloud VM", "a Slate cloud VM", "an eligible self-hosted pool", "the 'team-pool' self-hosted pool", "the 'worker-1' private worker", "a Slate cloud VM in the 'Saved' saved environment", "a Slate cloud VM in the 'env-1' saved environment"],
    );
    assert.deepEqual(
      [undefined, { type: "cloud" }, { type: "pool", name: "p", team_id: 7 }, { type: "machine", name: "w", team_id: 8 }, { type: "environment", id: "e", name: "n" }].map((environment) => toCloudAgentEnvironment(environment as never)),
      [undefined, { type: "cloud" }, { type: "pool", name: "p", teamId: 7 }, { type: "machine", name: "w", teamId: 8 }, { type: "environment", publicId: "e", name: "n" }],
    );
  });

  it("requires the fields an action cannot run without, and reads what the backend refused", () => {
    assert.equal(requireCloudAgentField("  a prompt  ", "prompt", "launch"), "a prompt");
    assert.throws(() => requireCloudAgentField("   ", "prompt", "launch"), (error: Error) => error instanceof SlateCloudAgentToolInputError && error.message === "'prompt' is required for the 'launch' action.");
    assert.equal(backendRejectionMessage({ detail: "  the repo is not approved  " }), "the repo is not approved");
    assert.equal(backendRejectionMessage({ details: [{ code: 1 }, { detail: "  no seats left  " }] }), "no seats left");
    assert.deepEqual([backendRejectionMessage({}), backendRejectionMessage("a string"), backendRejectionMessage(null), backendRejectionMessage({ details: [{}] })], [null, null, null, null]);
  });

  it("lines up the model catalog and the one-line summary of an agent", () => {
    assert.deepEqual(modelCatalogLines(catalog), ["- slate-fast (Fast) [aliases: fast]", "    effort: low | high", "    (restriction) effort=high cannot be combined with fast"]);
    assert.deepEqual(modelCatalogLines([]), []);
    assert.equal(summaryLine(summary("bc-1", { branchName: "feat/x", prUrl: "https://pr.test/1", isArchived: true })), "- bc-1 — agent bc-1 [running, archived, feat/x, https://pr.test/1] https://cloud.test/bc-1");
    assert.equal(summaryLine(summary("bc-2", { name: "   " })), "- bc-2 — (unnamed) [running] https://cloud.test/bc-2");
    assert.deepEqual([repoShortName("https://host.test/owner/repo.git"), repoShortName("https://host.test/owner/repo"), repoShortName("not a url"), repoShortName(undefined)], ["repo", "repo", undefined, undefined]);
  });

  it("passes a model and its parameters only when the catalog agrees", async () => {
    const api = { listModels: async () => catalog };
    assert.equal(await validateModelSelection(api, undefined, undefined), null);
    assert.equal(await validateModelSelection(api, "", { effort: "low" }), "'model' is required when 'model_params' are provided.");
    assert.equal(await validateModelSelection(api, "FAST"), null);
    assert.equal(await validateModelSelection(api, "nope"), "Unknown model 'nope'. Use the 'models' action to list valid models. Available: slate-fast.");
    assert.equal(await validateModelSelection(api, "slate-fast", { effort: "medium" }), "Invalid model_params for slate-fast: Invalid value 'medium' for 'effort' (allowed: low, high).");
    assert.equal(await validateModelSelection(api, "slate-fast", { unknown: "x" }), "Invalid model_params for slate-fast: Unknown parameter 'unknown'.");
    // A catalog that could not be read leaves the decision to the backend.
    assert.equal(await validateModelSelection({ listModels: async () => { throw new Error("down"); } }, "anything"), null);
    assert.equal(await validateModelSelection(api, "slate-fast", {}), null);
  });
});

describe("what the tool does", () => {
  it("derives confirmation and review gates from the action registry", () => {
    assert.deepEqual([...DESTRUCTIVE_ACTIONS], ["cancel", "archive", "unarchive", "delete"]);
    assert.deepEqual([...REVIEW_GATED_ACTIONS], ["launch", "reply", "rename", "cancel", "archive", "unarchive", "delete"]);
  });

  it("asks for a confirmation before anything destructive, and takes it as given", async () => {
    // The agent is one this session follows, so a delete has something to stop following.
    const world = toolWorld({ summaries: [summary("bc-1")] });
    assert.match(await runCloudAgentAction(world.ctx, { action: "delete", agent_id: "bc-1" }, world.deps), /'delete' is destructive/);
    assert.deepEqual(world.calls, []);
    assert.equal(await runCloudAgentAction(world.ctx, { action: "delete", agent_id: "bc-1", confirm: true }, world.deps), "Permanently deleted bc-1.");
    assert.deepEqual(world.named("delete").map((call) => call.args), ["bc-1"]);
    assert.equal(world.launchedIds.has("bc-1"), false);
    // A launch is not destructive, so it needs no confirmation.
    await runCloudAgentAction(world.ctx, { action: "launch", prompt: "do it", repo_url: "https://host.test/o/r" }, world.deps);
    assert.equal(world.named("launch").length, 1);
  });

  it("launches with what it was given, remembers the agent, and says what happens next", async () => {
    const watched = toolWorld();
    const answer = await runCloudAgentAction(watched.ctx, { action: "launch", prompt: "  do it  ", repo_url: "https://host.test/o/r", starting_ref: "main", model: "slate-fast", model_params: { effort: "low" }, title: "T", environment: { type: "machine", name: "worker-1", team_id: 3 } }, watched.deps);
    assert.match(answer, /^Launched cloud agent bc-new\.\nhttps:\/\/cloud\.test\/bc-new\nIt runs on the 'worker-1' private worker\. It opens a PR when done only if the worker can push to the repo\. You're revived automatically/);
    assert.deepEqual(watched.named("launch")[0]!.args, { prompt: "do it", repoUrl: "https://host.test/o/r", startingRef: "main", modelId: "slate-fast", modelParams: { effort: "low" }, images: [], title: "T", environment: { type: "machine", name: "worker-1", teamId: 3 } });
    assert.deepEqual([...watched.launchedIds], ["bc-new"]);
    assert.deepEqual(watched.watchCalls, [{ id: "bc-new", options: { quietOrigin: "quiet-origin" } }]);
    // Without a watcher there is nothing to be revived by, and the caller is told to ask instead.
    const unwatched = toolWorld({ watch: false });
    assert.match(await runCloudAgentAction(unwatched.ctx, { action: "launch", prompt: "p", repo_url: "https://host.test/o/r" }, unwatched.deps), /Use action "get" with this agent_id/);
    // A launch that the backend refused is answered with what it said; anything else is not swallowed.
    const refused = toolWorld({ launchFails: { detail: "the repo is not approved" } });
    assert.equal(await runCloudAgentAction(refused.ctx, { action: "launch", prompt: "p", repo_url: "https://host.test/o/r" }, refused.deps), "Could not launch the cloud agent: the repo is not approved");
    const broken = toolWorld({ launchFails: new Error("the service fell over") });
    await assert.rejects(runCloudAgentAction(broken.ctx, { action: "launch", prompt: "p", repo_url: "https://host.test/o/r" }, broken.deps), /the service fell over/);
  });

  it("refuses a launch that is missing what it needs, and one that was cancelled", async () => {
    const world = toolWorld();
    await assert.rejects(runCloudAgentAction(world.ctx, { action: "launch", repo_url: "https://host.test/o/r" }, world.deps), SlateCloudAgentToolInputError);
    await assert.rejects(runCloudAgentAction(world.ctx, { action: "launch", prompt: "p" }, world.deps), (error: Error) => error instanceof SlateCloudAgentToolInputError && error.message === "'repo_url' is required for the 'launch' action.");
    assert.equal(await runCloudAgentAction(world.ctx, { action: "launch", prompt: "p", environment: { type: "environment" } }, world.deps), "A saved-environment launch needs environment.name (the environment's display name) or environment.id (its public id).");
    // A saved environment may name no repository at all.
    const saved = toolWorld();
    await runCloudAgentAction(saved.ctx, { action: "launch", prompt: "p", environment: { type: "environment", name: "Saved" } }, saved.deps);
    assert.equal((saved.named("launch")[0]!.args as { repoUrl?: string }).repoUrl, undefined);
    assert.equal(await runCloudAgentAction(world.ctx, { action: "launch", prompt: "p", repo_url: "https://host.test/o/r", model: "nope" }, world.deps), "Unknown model 'nope'. Use the 'models' action to list valid models. Available: slate-fast.");
    const cancelled = toolWorld();
    const aborted = new AbortController();
    aborted.abort();
    assert.equal(await runCloudAgentAction({ ...cancelled.ctx, signal: aborted.signal }, { action: "launch", prompt: "p", repo_url: "https://host.test/o/r" }, cancelled.deps), CANCELLED_BEFORE_CLOUD_AGENT_CALL);
    assert.deepEqual(cancelled.calls, []);
  });

  it("sends an image failure back as the reason the action did not run", async () => {
    const world = toolWorld();
    const answer = await runCloudAgentAction(world.ctx, { action: "launch", prompt: "p", repo_url: "https://host.test/o/r", images: [{ url: "https://example.test/shot.png" }] }, world.deps);
    assert.match(answer, /^Could not launch the cloud agent: 'https:\/\/example\.test\/shot\.png' is not a file:\/\/ url\./);
    assert.deepEqual(world.calls, []);
    const followup = await runCloudAgentAction(world.ctx, { action: "reply", agent_id: "bc-1", prompt: "p", images: [{ url: "https://example.test/shot.png" }] }, world.deps);
    assert.match(followup, /^Could not send the follow-up: /);
  });

  it("lets the platform's review decide, and passes it the action, its images and the tool call", async () => {
    const seen: { args: CloudAgentToolArgs; toolCallId: string; images: readonly unknown[]; signal?: AbortSignal }[] = [];
    const deps = { ...toolWorld().deps, reviewAction: async (given: { args: CloudAgentToolArgs; toolCallId: string; images: readonly unknown[] }) => {
      seen.push(given);
      return { allowed: given.args.agent_id === "bc-allowed", reason: "not this one" };
    } };
    const ctx = toolWorld().ctx;
    assert.equal(await runCloudAgentAction(ctx, { action: "cancel", agent_id: "bc-1", confirm: true }, deps), "not this one");
    assert.equal(await runCloudAgentAction(ctx, { action: "cancel", agent_id: "bc-allowed", confirm: true }, deps), "Requested cancellation of the active run for bc-allowed.");
    assert.deepEqual(seen.map((given) => [given.args, given.toolCallId, given.images, given.signal?.aborted]), [
      [{ action: "cancel", agent_id: "bc-1", confirm: true }, "call-1", [], false],
      [{ action: "cancel", agent_id: "bc-allowed", confirm: true }, "call-1", [], false],
    ]);
    // A review that refuses stops the action before the backend is ever asked.
    const refusedWorld = toolWorld();
    let asked = 0;
    const reviewing = { ...refusedWorld.deps, reviewAction: async () => ({ allowed: (asked += 1) === 0, reason: "not this one" }) };
    assert.equal(await runCloudAgentAction(refusedWorld.ctx, { action: "cancel", agent_id: "bc-1", confirm: true }, reviewing), "not this one");
    assert.deepEqual(refusedWorld.named("cancel"), []);
    // An action the platform does not review is not taken to the reviewer at all.
    const unreviewed = toolWorld({ review: () => ({ allowed: false, reason: "never" }) });
    assert.equal(await runCloudAgentAction(unreviewed.ctx, { action: "get", agent_id: "bc-1" }, unreviewed.deps), "Cloud agent bc-1 — agent bc-1\nStatus: running\nURL: https://cloud.test/bc-1");
  });

  it("lists what this session followed, or everything the account has", async () => {
    const world = toolWorld({ summaries: [summary("bc-1"), summary("bc-2", { status: "finished" })] });
    assert.match(await runCloudAgentAction(world.ctx, { action: "list" }, world.deps), /^Cloud agents launched via this tool \(2\):/);
    assert.match(await runCloudAgentAction(world.ctx, { action: "list", scope: "all", limit: 5, include_archived: true }, world.deps), /^Cloud agents on the account \(2\):/);
    assert.deepEqual(world.named("list")[1]!.args, { limit: 5, includeArchived: true });
    const none = toolWorld({ summaries: [] });
    assert.equal(await runCloudAgentAction(none.ctx, { action: "list" }, none.deps), 'No cloud agents launched via this tool yet. Use scope: "all" to list every cloud agent on the account.');
    assert.equal(await runCloudAgentAction(none.ctx, { action: "list", scope: "all" }, none.deps), "No cloud agents found.");
  });

  it("answers with the models it can be launched with", async () => {
    const world = toolWorld();
    assert.match(await runCloudAgentAction(world.ctx, { action: "models" }, world.deps), /^Available cloud-agent models \(1\)\./);
    const empty = toolWorld({ models: [] });
    assert.equal(await runCloudAgentAction(empty.ctx, { action: "models" }, empty.deps), "No models available.");
  });

  it("reads one agent, with the parts that are there", async () => {
    const full = toolWorld({ detail: summary("bc-1", { name: "Named", isArchived: true, branchName: "feat/x", prUrl: "https://pr.test/1", filesChanged: 2, linesAdded: 10, linesRemoved: 3, error: "one file did not apply" }) });
    assert.deepEqual((await runCloudAgentAction(full.ctx, { action: "get", agent_id: "bc-1" }, full.deps)).split("\n"), [
      "Cloud agent bc-1 — Named",
      "Status: running (archived)",
      "URL: https://cloud.test/bc-1",
      "Branch: feat/x",
      "Pull request: https://pr.test/1",
      "Changes: +10/-3 across 2 file(s).",
      "one file did not apply",
    ]);
    const missing = toolWorld({ detail: null });
    assert.equal(await runCloudAgentAction(missing.ctx, { action: "get", agent_id: "bc-9" }, missing.deps), "No cloud agent found for bc-9.");
  });

  it("dumps a transcript for an agent this session follows, and only for one", async () => {
    const world = toolWorld({ summaries: [summary("bc-1")], transcript: { status: "running", lineCount: 2, jsonl: "a\nb" } });
    assert.match(await runCloudAgentAction(world.ctx, { action: "dump", agent_id: "bc-1" }, world.deps), /^Wrote bc-1's full transcript to cloud-agent-transcripts\/bc-1\.jsonl \(3 bytes, 2 message lines\)\.\nThe run is still in progress/);
    const refused = await runCloudAgentAction(world.ctx, { action: "dump", agent_id: "bc-other" }, world.deps);
    assert.match(refused, /^dump is limited to agents this session has launched, watched, or replied to \(not bc-other\)/);
    assert.doesNotMatch(refused, /\bgh\b/);
    const empty = toolWorld({ summaries: [summary("bc-1")], transcript: { status: "finished", lineCount: 0, jsonl: "" } });
    assert.equal(await runCloudAgentAction(empty.ctx, { action: "dump", agent_id: "bc-1" }, empty.deps), "Cloud agent bc-1 hasn't produced any transcript output yet. The run has finished, so this is the complete transcript.");
    const gone = toolWorld({ summaries: [summary("bc-1")], transcript: null });
    assert.equal(await runCloudAgentAction(gone.ctx, { action: "dump", agent_id: "bc-1" }, gone.deps), "No cloud agent found for bc-1.");
  });

  it("watches an agent, and says so when there is nothing to watch with", async () => {
    const world = toolWorld();
    assert.equal(await runCloudAgentAction(world.ctx, { action: "watch", agent_id: "bc-7" }, world.deps), "Watching bc-7. You'll be revived automatically when it finishes — keep working and don't poll it.");
    assert.deepEqual([...world.launchedIds], ["bc-7"]);
    const unwatched = toolWorld({ watch: false });
    assert.equal(await runCloudAgentAction(unwatched.ctx, { action: "watch", agent_id: "bc-7" }, unwatched.deps), "Watching isn't available here. Use action \"get\" with bc-7 to check its status.");
  });

  it("replies, telling an interrupted run from one that had nothing to interrupt", async () => {
    const running = toolWorld({ detail: summary("bc-1", { status: "running" }) });
    assert.match(await runCloudAgentAction(running.ctx, { action: "reply", agent_id: "bc-1", prompt: "more", interrupt: true, model: "slate-fast" }, running.deps), /^Interrupted bc-1's active run and delivered the follow-up immediately \(run run-1\); it starts processing now\./);
    assert.deepEqual(running.named("reply")[0]!.args, { bcId: "bc-1", prompt: "more", modelId: "slate-fast", modelParams: undefined, images: [], interrupt: true });
    assert.deepEqual(running.watchCalls, [{ id: "bc-1", options: { afterFollowup: true, quietOrigin: "quiet-origin" } }]);
    const idle = toolWorld({ detail: summary("bc-1", { status: "finished" }) });
    assert.match(await runCloudAgentAction(idle.ctx, { action: "reply", agent_id: "bc-1", prompt: "more", interrupt: true }, idle.deps), /^Sent follow-up to bc-1 \(run run-1\); it wasn't running, so there was nothing to interrupt/);
    // A reply of a cloud agent the backend refused is answered with what it said.
    const refused = toolWorld({ replyFails: { details: [{ detail: "  no seats left  " }] } });
    assert.equal(await runCloudAgentAction(refused.ctx, { action: "reply", agent_id: "bc-1", prompt: "more" }, refused.deps), "Could not send the follow-up: no seats left");
    const broken = toolWorld({ replyFails: new Error("down") });
    await assert.rejects(runCloudAgentAction(broken.ctx, { action: "reply", agent_id: "bc-1", prompt: "more" }, broken.deps), /down/);
  });

  it("renames, archives, unarchives and lists artifacts", async () => {
    const world = toolWorld({ renameFails: undefined });
    assert.match(await runCloudAgentAction(world.ctx, { action: "rename", agent_id: "bc-1", title: "  New name  " }, world.deps), /^Renamed bc-1 to "New name"\. The new title shows everywhere the agent appears \(across Slate, the IDE sidebar and mobile\)\.$/);
    assert.deepEqual(world.named("rename")[0]!.args, { id: "bc-1", title: "New name" });
    assert.equal(await runCloudAgentAction(world.ctx, { action: "archive", agent_id: "bc-1", confirm: true }, world.deps), "Archived bc-1.");
    assert.equal(await runCloudAgentAction(world.ctx, { action: "unarchive", agent_id: "bc-1", confirm: true }, world.deps), "Unarchived bc-1.");
    assert.deepEqual(world.named("setArchived").map((call) => call.args), [{ id: "bc-1", archived: true }, { id: "bc-1", archived: false }]);
    const refused = toolWorld({ renameFails: { detail: "that name is taken" } });
    assert.equal(await runCloudAgentAction(refused.ctx, { action: "rename", agent_id: "bc-1", title: "T" }, refused.deps), "Could not rename the cloud agent: that name is taken");
    const artifacts = toolWorld({ artifacts: [{ path: "out/report.md", sizeBytes: 12 }] });
    assert.match(await runCloudAgentAction(artifacts.ctx, { action: "list_artifacts", agent_id: "bc-1" }, artifacts.deps), /^Artifacts for bc-1 \(1\):\n- out\/report\.md \(12 bytes\)$/);
    assert.equal(await runCloudAgentAction(world.ctx, { action: "list_artifacts", agent_id: "bc-empty" }, world.deps), "No artifacts for bc-empty.");
  });

  it("offers itself as a tool named CloudAgent, with the repository as its activity line", () => {
    const world = toolWorld();
    const tool = createCloudAgentTool(world.deps);
    assert.deepEqual([tool.id, tool.toolIdentifier, tool.name], ["CLOUD_AGENT", "CLOUD_AGENT", "CloudAgent"]);
    assert.equal(tool.description.startsWith("Manage Slate cloud agents:"), true);
    assert.deepEqual(tool.describeActivity({ action: "launch", repo_url: "https://host.test/o/slate.git" }), { detail: "slate" });
    assert.equal(tool.describeActivity({ action: "list" }), undefined);
    return tool.execute(world.ctx, { action: "list" }).then((answer) => assert.equal(typeof answer, "string"));
  });
});
