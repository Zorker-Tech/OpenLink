/**
 * Publishing a skill to a team's marketplace, and taking it back: which teams a skill may go to, what is staged and
 * packed, when the library copy stands down, and what a failure leaves behind.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { GetTeamsRequest, PublishPluginRequest, UnpublishPluginRequest } from "../../source/packages/proto/generated/aiserver/v1/dashboard_pb.ts";
import { getGlobalWorkflowsDir, type GlobalWorkflowRecord } from "../../source/host/workflows/workflow-library.ts";
import {
  CONFIRM_PUBLISH_MAX_ATTEMPTS,
  createSlateSkillPublishClient,
  errorMessage,
  publishableTeams,
  PUBLISH_SKILL_RPC_TIMEOUT_MS,
  PUBLISH_TARGETS_RPC_TIMEOUT_MS,
  readManifestName,
  readSkillFrontmatter,
  requireManifestName,
  SlateSkillPublishService,
  skillsRootRelativePath,
  stageSkillDirForPublish,
  UNPUBLISHABLE_FILES,
  type SkillPublishClient,
  type SlateSkillPublishServiceOptions,
} from "../../source/host/skills/skill-publish.ts";
import type { PluginSkillRecord, PluginSkillsCache } from "../../source/host/skills/plugin-skills-cache.ts";

const scratch = mkdtempSync(join(tmpdir(), "slate-skill-publish-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

const skillFile = (dir: string, name: string, description: string, body = "do it") => {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "SKILL.md");
  writeFileSync(path, `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`);
  return path;
};

let worldCount = 0;

function publishWorld(options: { teams?: readonly { id: number; isDirectMember: boolean; name: string }[]; teamsFail?: boolean; pluginId?: string; commitSha?: string; publishFails?: unknown; index?: PluginSkillsCache | null } = {}) {
  // Every world gets a platform root of its own: a test that writes one must not be read by another.
  const slateRootDir = join(scratch, `root-${worldCount++}`);
  const calls: { name: string; args: unknown; timeoutMs?: number }[] = [];
  const client: SkillPublishClient = {
    getTeams: async (request: GetTeamsRequest, given) => {
      calls.push({ name: "getTeams", args: request, timeoutMs: given.timeoutMs });
      if (options.teamsFail === true) throw new Error("the backend is unreachable");
      return { teams: options.teams ?? [{ id: 7, isDirectMember: true, name: "Team Seven" }] };
    },
    publishPlugin: async (request: PublishPluginRequest, given) => {
      calls.push({ name: "publishPlugin", args: request, timeoutMs: given.timeoutMs });
      if (options.publishFails !== undefined) throw options.publishFails;
      return { pluginId: options.pluginId ?? "42", commitSha: options.commitSha ?? "sha-1" };
    },
    unpublishPlugin: async (request: UnpublishPluginRequest, given) => {
      calls.push({ name: "unpublishPlugin", args: request, timeoutMs: given.timeoutMs });
      return {};
    },
  };
  const logs: string[] = [];
  const edgeFailures: { stage: string; errorClass: string }[] = [];
  let index = options.index ?? null;
  const syncs: string[] = [];
  const service = new SlateSkillPublishService({
    slateRootDir,
    client,
    pluginSkills: {
      currentIndex: () => index,
      sync: async (trigger) => void syncs.push(trigger),
    },
    log: (message) => void logs.push(message),
    reportEdgeFailed: (event) => void edgeFailures.push(event),
  });
  return { service, calls, logs, edgeFailures, syncs, slateRootDir, setIndex: (next: PluginSkillsCache | null) => void (index = next), named: (name: string) => calls.filter((call) => call.name === name) };
}

const pluginSkill = (overrides: Partial<PluginSkillRecord> = {}): PluginSkillRecord => ({
  id: "skill-one",
  pluginId: "42",
  pluginName: "plugin-one",
  name: "Skill One",
  description: "does one thing",
  filePath: join(scratch, "plugins", "one", "skills", "skill-one", "SKILL.md"),
  pluginVersion: "sha-1",
  installPath: join(scratch, "plugins", "one"),
  skillRelativePath: "skills/skill-one/SKILL.md",
  publisherUserId: 5,
  marketplaceTeamId: 7,
  ...overrides,
});

const cacheWith = (skills: readonly PluginSkillRecord[], currentUserId: number | null = 5): PluginSkillsCache => ({ fetchedAt: 1, currentUserId, skills: [...skills], authBlocked: [] });

/** The service reads its library from the options; a test hands one in the same way. */
const useLibrary = (world: { service: SlateSkillPublishService }, library: SkillPublishLibrary): void => {
  (world.service as unknown as { library: SkillPublishLibrary }).library = library;
};

interface SkillPublishLibrary {
  get(id: string): GlobalWorkflowRecord | null;
  remove(id: string): boolean;
}

/** The service keeps its options; a test hands a changed one in the same way. */
const useOptions = (world: { service: SlateSkillPublishService }, options: SlateSkillPublishServiceOptions): void => {
  (world.service as unknown as { options: SlateSkillPublishServiceOptions }).options = options;
};

describe("the pure pieces of publishing", () => {
  it("takes the teams the account is a direct member of", () => {
    assert.deepEqual(publishableTeams({ teams: [{ id: 1, isDirectMember: true, name: "One" }, { id: 2, isDirectMember: false, name: "Two" }, { id: 0, isDirectMember: true, name: "Zero" }, { id: 3, isDirectMember: true, name: "Three" }] }), [{ teamId: 1, name: "One" }, { teamId: 3, name: "Three" }]);
    assert.deepEqual([PUBLISH_SKILL_RPC_TIMEOUT_MS, PUBLISH_TARGETS_RPC_TIMEOUT_MS, CONFIRM_PUBLISH_MAX_ATTEMPTS], [60_000, 10_000, 5]);
    assert.deepEqual([...UNPUBLISHABLE_FILES].sort(), ["runs.json", "workflow.md"]);
    assert.equal(errorMessage(new Error("boom")), "boom");
    assert.equal(errorMessage("boom"), "boom");
  });

  it("stages a skill without the files a marketplace does not take, keeping nested ones", async () => {
    const skillDir = join(scratch, "staging", "skill-one");
    mkdirSync(join(skillDir, "nested"), { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "body");
    writeFileSync(join(skillDir, "runs.json"), "[]");
    writeFileSync(join(skillDir, "workflow.md"), "legacy");
    writeFileSync(join(skillDir, "nested", "runs.json"), "[]");
    const staged = await stageSkillDirForPublish({ skillDir, targetDir: join(scratch, "staging", "out") });
    assert.equal(staged, join(scratch, "staging", "out", "skill-one"));
    assert.deepEqual(readdirSync(staged).sort(), ["SKILL.md", "nested"]);
    assert.deepEqual(readdirSync(join(staged, "nested")), ["runs.json"]);
  });

  it("reads what a skill calls itself, and refuses one whose file says nothing", () => {
    const path = skillFile(join(scratch, "frontmatter"), "Named Skill", "does things");
    assert.deepEqual(readSkillFrontmatter(path), { name: "Named Skill", description: "does things" });
    const empty = join(scratch, "frontmatter", "empty", "SKILL.md");
    mkdirSync(join(scratch, "frontmatter", "empty"), { recursive: true });
    writeFileSync(empty, "");
    assert.throws(() => readSkillFrontmatter(empty), /could not be read/);
    assert.throws(() => readSkillFrontmatter(join(scratch, "frontmatter", "missing", "SKILL.md")), /could not be read/);
  });

  it("reads a plugin's manifest name, and refuses to sync without one", async () => {
    const named = join(scratch, "manifest", "named");
    mkdirSync(named, { recursive: true });
    writeFileSync(join(named, "plugin.json"), JSON.stringify({ name: "plugin-one" }));
    assert.equal(await readManifestName(named), "plugin-one");
    assert.equal(await requireManifestName(named), "plugin-one");
    const blank = join(scratch, "manifest", "blank");
    mkdirSync(blank, { recursive: true });
    writeFileSync(join(blank, "plugin.json"), JSON.stringify({ name: "  " }));
    assert.equal(await readManifestName(blank), null);
    assert.equal(await readManifestName(join(scratch, "manifest", "missing")), null);
    await assert.rejects(requireManifestName(blank), /risk publishing a duplicate/);
  });

  it("works out where a skill sits inside its plugin, and refuses a path it cannot re-pack", () => {
    assert.equal(skillsRootRelativePath("skills/skill-one/SKILL.md"), "skill-one");
    assert.equal(skillsRootRelativePath("skill-one/SKILL.md"), "skill-one");
    assert.equal(skillsRootRelativePath("skills/a/b/SKILL.md"), "a/b");
    // A backslash is not a separator this platform's path handling knows, so the whole thing is the file name.
    assert.equal(skillsRootRelativePath("skills\\skill-one\\SKILL.md"), ".");
    // A bare file name has no directory to strip, and a path that is only the root cannot be re-packed.
    assert.equal(skillsRootRelativePath("SKILL.md"), ".");
    assert.throws(() => skillsRootRelativePath("skills/SKILL.md"), /cannot re-pack/);
    assert.throws(() => skillsRootRelativePath("skills//SKILL.md"), /cannot re-pack/);
  });
});

describe("the service", () => {
  it("lists the teams a skill may go to, and says which failure it was", async () => {
    const world = publishWorld();
    assert.deepEqual(await world.service.listTargets(), { teams: [{ teamId: 7, name: "Team Seven" }], unavailableReason: null });
    assert.deepEqual(world.named("getTeams")[0]!.timeoutMs, PUBLISH_TARGETS_RPC_TIMEOUT_MS);
    // A backend that could not be reached is not the same as an account with no team.
    const unreachable = publishWorld({ teamsFail: true });
    assert.deepEqual(await unreachable.service.listTargets(), { teams: [], unavailableReason: "Could not reach Slate to check your teams." });
    assert.deepEqual(unreachable.edgeFailures, [{ stage: "list_targets", errorClass: "Error" }]);
    assert.match(unreachable.logs[0]!, /^\[slate:skill-publish\] failed to resolve publishable teams: the backend is unreachable$/);
    const noTeams = publishWorld({ teams: [{ id: 7, isDirectMember: false, name: "Not mine" }] });
    assert.deepEqual(await noTeams.service.listTargets(), { teams: [], unavailableReason: "Publishing a skill needs a Slate team. Join or create one, then try again." });
  });

  it("publishes a library skill, and hands the library copy over only once it landed", async () => {
    const world = publishWorld();
    const skillDir = join(world.slateRootDir, "workflows", "skill-one");
    const filePath = skillFile(skillDir, "Skill One", "does one thing");
    const records = new Map([["skill-one", { id: "skill-one", name: "Skill One", description: "does one thing", body: "do it", suggestedTrigger: null, sourceRef: null, helperScripts: [], createdAt: 1, filePath }]]);
    const removed: string[] = [];
    useLibrary(world, { get: (id: string) => records.get(id) ?? null, remove: (id) => (removed.push(id), records.delete(id)) });
    // The plugin is not installed yet, so nothing is promoted.
    assert.deepEqual(await world.service.publish({ workflowId: "skill-one", teamId: 7 }), { pluginId: "42", commitSha: "sha-1", promotedWorkflowId: null });
    assert.deepEqual(removed, []);
    assert.match(world.logs.at(-1)!, /kept the library copy of skill-one: commit sha-1 was not confirmed installed/);
    const published = world.named("publishPlugin")[0]!.args as PublishPluginRequest;
    assert.deepEqual([published.teamId, published.name, published.displayName, published.description], [7, "skill-one", "Skill One", "does one thing"]);
    assert.equal(published.pluginTarGz.byteLength > 0, true);
    assert.deepEqual(world.named("publishPlugin")[0]!.timeoutMs, PUBLISH_SKILL_RPC_TIMEOUT_MS);
    // Once the plugin really is installed, the library copy stands down.
    const landed = publishWorld();
    const landedDir = join(landed.slateRootDir, "workflows", "skill-one");
    const landedFile = skillFile(landedDir, "Skill One", "does one thing");
    const kept = new Map([["skill-one", { id: "skill-one", name: "Skill One", description: "does one thing", body: "do it", suggestedTrigger: null, sourceRef: null, helperScripts: [], createdAt: 1, filePath: landedFile }]]);
    const promoted: string[] = [];
    useLibrary(landed, { get: (id: string) => kept.get(id) ?? null, remove: (id) => (promoted.push(id), kept.delete(id)) });
    landed.setIndex(cacheWith([pluginSkill({ id: "installed-skill", filePath: landedFile, pluginVersion: "sha-1", pluginId: "42" })]));
    assert.deepEqual(await landed.service.publish({ workflowId: "skill-one", teamId: 7 }), { pluginId: "42", commitSha: "sha-1", promotedWorkflowId: "installed-skill" });
    assert.deepEqual(promoted, ["skill-one"]);
    // Syncing happens while confirming, and the attempt bound is the platform's own.
    assert.equal(landed.syncs.length >= 1 && landed.syncs.every((trigger) => trigger === "install"), true);
  });

  it("refuses a publish that has no skill, no team, or no description", async () => {
    const world = publishWorld();
    await assert.rejects(world.service.publish({ workflowId: "missing", teamId: 7 }), /no longer exists in your library/);
    const skillDir = join(world.slateRootDir, "workflows", "skill-one");
    const filePath = skillFile(skillDir, "Skill One", "does one thing");
    useLibrary(world, { get: () => ({ id: "skill-one", name: "Skill One", description: "does one thing", body: "do it", suggestedTrigger: null, sourceRef: null, helperScripts: [], createdAt: 1, filePath }), remove: () => true });
    for (const teamId of [0, -1, 1.5]) {
      await assert.rejects(world.service.publish({ workflowId: "skill-one", teamId }), /Choose a team to publish this skill to/);
    }
    await assert.rejects(world.service.upload({ skillDir, skillRelativePath: "skill-one", name: "N", description: "   ", teamId: 7, pluginName: "p" }), /Add a description before publishing/);
    assert.deepEqual(world.named("publishPlugin"), []);
  });

  it("keeps the work directory out of the way whether the publish worked or not", async () => {
    const world = publishWorld({ publishFails: new Error("the team has no seats") });
    const skillDir = join(world.slateRootDir, "workflows", "skill-two");
    skillFile(skillDir, "Skill Two", "does two things");
    await assert.rejects(world.service.upload({ skillDir, skillRelativePath: "skill-two", name: "Skill Two", description: "does two things", teamId: 7, pluginName: "plugin-two" }), /no seats/);
    // The staged copy is gone: nothing of the temporary work is left in the platform's temporary directory.
    const leftovers = readdirSync(tmpdir()).filter((name) => name.startsWith("slate-publish-skill-"));
    assert.equal(leftovers.filter((name) => readFileSync(join(tmpdir(), name, "staged", "SKILL.md"), "utf8").includes("two things")).length, 0);
  });

  it("syncs and takes an unpublished plugin back, in that order", async () => {
    const world = publishWorld();
    const installPath = join(world.slateRootDir, "plugins", "plugin-one");
    const filePath = skillFile(join(installPath, "skills", "skill-one"), "Skill One", "does one thing");
    const record = pluginSkill({ filePath, installPath });
    world.setIndex(cacheWith([record]));
    // The skill is restored into the library before the plugin is taken down.
    // What the service asks the library — the restore reads it first — and when it takes the plugin down.
    const order: string[] = [];
    useLibrary(world, { get: () => (order.push("library-get"), null), remove: () => false });
    const originalUnpublish = world.service.options.client.unpublishPlugin;
    useOptions(world, { ...world.service.options, client: { ...world.service.options.client, unpublishPlugin: async (request: UnpublishPluginRequest, given: { timeoutMs: number }) => (order.push("unpublish"), await originalUnpublish(request, given)) } });
    const result = await world.service.unpublish({ workflowId: "skill-one" });
    assert.equal(typeof result.restoredWorkflowId, "string");
    assert.equal(existsSync(join(getGlobalWorkflowsDir(world.slateRootDir), result.restoredWorkflowId!, "SKILL.md")), true);
    // The skill is restored first: the library is read, and the plugin only goes down after that.
    assert.deepEqual(order, ["library-get", "unpublish"]);
    const unpublished = world.named("unpublishPlugin")[0]!.args as UnpublishPluginRequest & { pluginId: bigint };
    assert.deepEqual([unpublished.teamId, unpublished.pluginId], [7, 42n]);
    assert.deepEqual(world.syncs, ["install"]);
    // A skill the library already has is not restored twice.
    const again = publishWorld();
    const againPath = skillFile(join(again.slateRootDir, "plugins", "plugin-one", "skills", "skill-one"), "Skill One", "does one thing");
    again.setIndex(cacheWith([pluginSkill({ filePath: againPath, installPath: join(again.slateRootDir, "plugins", "plugin-one") })]));
    // The skill is already in the library — its directory is really there — so nothing is restored a second time.
    skillFile(join(getGlobalWorkflowsDir(again.slateRootDir), "skill-one"), "Skill One", "does one thing");
    useLibrary(again, { get: (id: string) => (id === "skill-one" ? ({ id, filePath: againPath } as never) : null), remove: () => false });
    assert.deepEqual(await again.service.unpublish({ workflowId: "skill-one" }), { restoredWorkflowId: "skill-one" });
  });

  it("only syncs or takes back a plugin skill this account published into a team marketplace", async () => {
    const notOurs = publishWorld();
    notOurs.setIndex(cacheWith([pluginSkill({ publisherUserId: 9 })]));
    await assert.rejects(notOurs.service.resync({ workflowId: "skill-one" }), /belongs to a plugin you did not publish/);
    const noPublisher = publishWorld();
    noPublisher.setIndex(cacheWith([pluginSkill({ publisherUserId: null })]));
    await assert.rejects(noPublisher.service.resync({ workflowId: "skill-one" }), /belongs to a plugin you did not publish/);
    const noTeam = publishWorld();
    noTeam.setIndex(cacheWith([pluginSkill({ marketplaceTeamId: null })]));
    await assert.rejects(noTeam.service.resync({ workflowId: "skill-one" }), /is not in a team marketplace/);
    const notInstalled = publishWorld();
    notInstalled.setIndex(null);
    await assert.rejects(notInstalled.service.resync({ workflowId: "skill-one" }), /no longer installed/);
    assert.deepEqual([notOurs.named("publishPlugin").length, noPublisher.named("publishPlugin").length, noTeam.named("publishPlugin").length], [0, 0, 0]);
  });

  it("resyncs a published skill under the name it now calls itself, keeping the plugin's own name", async () => {
    const world = publishWorld();
    const installPath = join(world.slateRootDir, "plugins", "plugin-one");
    const filePath = skillFile(join(installPath, "skills", "skill-one"), "Renamed Skill", "does one thing now");
    // The plugin already has a name of its own, which is the one it stays published under.
    writeFileSync(join(installPath, "plugin.json"), JSON.stringify({ name: "plugin-one" }));
    world.setIndex(cacheWith([pluginSkill({ filePath, installPath })]));
    assert.deepEqual(await world.service.resync({ workflowId: "skill-one" }), { pluginId: "42", commitSha: "sha-1", promotedWorkflowId: null });
    const published = world.named("publishPlugin")[0]!.args as PublishPluginRequest;
    assert.deepEqual([published.name, published.displayName, published.description], ["plugin-one", "Renamed Skill", "does one thing now"]);
    assert.deepEqual(world.syncs, ["install"]);
    // A skill whose file says nothing about a name keeps the name it had.
    const unnamed = publishWorld();
    const unnamedInstall = join(unnamed.slateRootDir, "plugins", "plugin-one");
    const unnamedPath = join(unnamedInstall, "skills", "skill-one", "SKILL.md");
    mkdirSync(join(unnamedInstall, "skills", "skill-one"), { recursive: true });
    writeFileSync(join(unnamedInstall, "plugin.json"), JSON.stringify({ name: "plugin-one" }));
    writeFileSync(unnamedPath, "---\ndescription: only a description\n---\n\nbody\n");
    unnamed.setIndex(cacheWith([pluginSkill({ filePath: unnamedPath, installPath: unnamedInstall })]));
    await unnamed.service.resync({ workflowId: "skill-one" });
    assert.equal((unnamed.named("publishPlugin")[0]!.args as PublishPluginRequest).displayName, "Skill One");
  });

  it("reports a sync that failed without failing what the caller asked for", async () => {
    const world = publishWorld();
    useOptions(world, { ...world.service.options, pluginSkills: { currentIndex: () => null, sync: async () => { throw new Error("the index is broken"); } } });
    await world.service.syncBestEffort();
    assert.deepEqual(world.edgeFailures, [{ stage: "sync", errorClass: "Error" }]);
    assert.match(world.logs.at(-1)!, /plugin-skills sync after publish failed: the index is broken/);
    // A confirm that never sees the commit gives up after the platform's own bound.
    const never = publishWorld();
    never.setIndex(cacheWith([pluginSkill({ pluginVersion: "other" })]));
    assert.equal(await never.service.confirmPublishLanded({ pluginId: "42", commitSha: "sha-1" }), null);
    assert.equal(never.syncs.length, CONFIRM_PUBLISH_MAX_ATTEMPTS);
  });

  it("offers a client that reads the account's token for the backend the platform uses", async () => {
    const asked: string[] = [];
    const client = createSlateSkillPublishClient({ auth: { getAccessToken: async ({ backendUrl }) => (asked.push(backendUrl), "token"), getMachineId: async () => "machine" } });
    assert.equal(typeof client.getTeams, "function");
    assert.equal(typeof client.publishPlugin, "function");
    assert.equal(typeof client.unpublishPlugin, "function");
    assert.deepEqual(asked, []);
    // The request types the client speaks are the platform's own.
    assert.equal(new GetTeamsRequest({ activeOnly: true }).activeOnly, true);
    assert.equal(new PublishPluginRequest({ teamId: 7, name: "n", displayName: "N", description: "d" }).teamId, 7);
    assert.equal(new UnpublishPluginRequest({ pluginId: 42n, teamId: 7 }).teamId, 7);
  });
});
