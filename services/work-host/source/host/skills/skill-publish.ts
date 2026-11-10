/**
 * Publishing a skill to a team's marketplace, and taking it back.
 *
 * Publishing is a five-step journey that has to leave nothing behind: the skill is staged (with the files a marketplace
 * may not carry dropped), packed as a plugin, published with the team's own name for it, and then confirmed to have
 * landed — only then does the library copy stand down, because until the plugin is really installed the library is the
 * only copy the user has. A publish that was never confirmed keeps that copy and says so. Unpublishing is the mirror
 * image: the skill goes back into the library first, and only then is the plugin taken down.
 */

import { existsSync, readFileSync } from "node:fs";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { packPluginArtifact } from "../../packages/plugin-install/tarball.ts";
import { restoreSkillsFromPluginDir } from "../../packages/plugin-install/skill-plugin-restore.ts";
import { writeLocalSkillPackage } from "../../packages/plugin-install/skill-plugin-synthesizer.ts";
import { errorLogTag } from "../../shared/errors/summary.ts";
import { LEGACY_WORKFLOW_FILENAME, parseWorkflowFile } from "../../shared/workflow-model.ts";
import { SlateSkillPublishError } from "../../shared/workflows.ts";
import { GlobalWorkflowLibrary, getGlobalWorkflowsDir, type GlobalWorkflowRecord } from "../workflows/workflow-library.ts";
import type { PluginSkillRecord, PluginSkillsCache } from "./plugin-skills-cache.ts";
import {
  PUBLISHED_SKILL_CONFIRM_ATTEMPTS,
  SKILL_PUBLISH_REQUEST_TIMEOUT_MS,
  SKILL_PUBLISH_TARGETS_TIMEOUT_MS,
  type PublishedSkillResult,
  type SkillPublishClient,
  type SkillPublishTeam,
} from "./skill-publish-contracts.ts";

export type { PublishedSkillResult, SkillPublishClient } from "./skill-publish-contracts.ts";

export const PUBLISH_SKILL_RPC_TIMEOUT_MS = SKILL_PUBLISH_REQUEST_TIMEOUT_MS;
export const PUBLISH_TARGETS_RPC_TIMEOUT_MS = SKILL_PUBLISH_TARGETS_TIMEOUT_MS;
export const CONFIRM_PUBLISH_MAX_ATTEMPTS = PUBLISHED_SKILL_CONFIRM_ATTEMPTS;
/** Files a published plugin does not carry: the legacy name, and what a run leaves behind. */
export const UNPUBLISHABLE_FILES = new Set([LEGACY_WORKFLOW_FILENAME, "runs.json"]);

const LOG_PREFIX = "[slate:skill-publish]";

export interface SkillPublishPluginSkills {
  currentIndex(): PluginSkillsCache | null;
  sync(trigger: string): Promise<unknown>;
}

export interface SkillPublishLibrary {
  get(id: string): GlobalWorkflowRecord | null;
  remove(id: string): boolean;
}

export interface SkillMarketplacePublisherOptions {
  slateRootDir: string;
  client: SkillPublishClient;
  pluginSkills: SkillPublishPluginSkills;
  library?: SkillPublishLibrary;
  log?(message: string): void;
  reportEdgeFailed?(event: { stage: "list_targets" | "cleanup" | "sync"; errorClass: string }): void;
}

/** The teams a skill may be published to: the ones the account is a direct member of. */
export function selectPublishableTeams(response: { teams: readonly SkillPublishTeam[] }): Array<{ teamId: number; name: string }> {
  return response.teams.filter((team) => team.id > 0 && team.isDirectMember).map((team) => ({ teamId: team.id, name: team.name }));
}

/** A copy of the skill to publish, without the files a marketplace does not take. */
export async function stageSkillDirectory(args: { skillDir: string; targetDir: string }): Promise<string> {
  const staged = join(args.targetDir, basename(args.skillDir));
  await cp(args.skillDir, staged, {
    recursive: true,
    dereference: true,
    // Only what sits right beside the skill's own file is left out; a nested file of that name is the skill's business.
    filter: (source) => dirname(source) !== args.skillDir || !UNPUBLISHABLE_FILES.has(basename(source)),
  });
  return staged;
}

/** What a skill calls itself, as its own file says. */
export function readSkillIdentity(filePath: string): { name: string; description: string } {
  let parsed = null;
  try {
    parsed = parseWorkflowFile(readFileSync(filePath, "utf8"));
  } catch {}
  if (parsed == null) throw new SlateSkillPublishError("That skill's file could not be read.");
  return { name: parsed.name, description: parsed.description };
}

export async function readPluginPackageName(pluginDir: string): Promise<string | null> {
  try {
    const manifest = JSON.parse(await readFile(join(pluginDir, "plugin.json"), "utf8")) as { name?: unknown };
    return typeof manifest.name === "string" && manifest.name.trim() !== "" ? manifest.name : null;
  } catch {
    return null;
  }
}

/** The name a plugin is already published under: syncing without it would publish a second copy. */
export async function requirePluginPackageName(installPath: string): Promise<string> {
  const name = await readPluginPackageName(installPath);
  if (name == null) throw new SlateSkillPublishError("Could not read that plugin's manifest, so syncing would risk publishing a duplicate. Reinstall the plugin and try again.");
  return name;
}

/** Where a skill sits inside the plugin that carries it, without the root it was installed under. */
export function relativeSkillPackagePath(skillRelativePath: string): string {
  const segments = dirname(skillRelativePath).split(/[/\\]/).filter(Boolean);
  const withoutRoot = segments[0] === "skills" ? segments.slice(1) : segments;
  if (withoutRoot.length === 0) throw new SlateSkillPublishError("That skill sits at a path Slate cannot re-pack.");
  return withoutRoot.join("/");
}

export function explainPublishFailure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class SkillMarketplacePublisher {
  readonly library: SkillPublishLibrary;

  constructor(readonly options: SkillMarketplacePublisherOptions) {
    this.library = options.library ?? new GlobalWorkflowLibrary(getGlobalWorkflowsDir(options.slateRootDir));
  }

  async listTargets(): Promise<{ teams: Array<{ teamId: number; name: string }>; unavailableReason: string | null }> {
    let response: { teams: readonly SkillPublishTeam[] };
    try {
      response = await this.options.client.getTeams();
    } catch (error) {
      // A team list that could not be read is not a list of no teams: the caller is told which it was.
      this.options.log?.(`${LOG_PREFIX} failed to resolve publishable teams: ${explainPublishFailure(error)}`);
      this.options.reportEdgeFailed?.({ stage: "list_targets", errorClass: errorLogTag(error) });
      return { teams: [], unavailableReason: "Could not reach Slate to check your teams." };
    }
    const teams = selectPublishableTeams(response);
    return { teams, unavailableReason: teams.length > 0 ? null : "Publishing a skill needs a Slate team. Join or create one, then try again." };
  }

  /** Publishes a library skill, and hands the library copy over only once the plugin is really installed. */
  async publish(args: { workflowId: string; teamId: number }): Promise<PublishedSkillResult & { promotedWorkflowId: string | null }> {
    const record = this.requireLibraryWorkflow(args.workflowId);
    if (!Number.isInteger(args.teamId) || args.teamId <= 0) throw new SlateSkillPublishError("Choose a team to publish this skill to.");
    const published = await this.publishArchive({ skillDir: dirname(record.filePath), skillRelativePath: record.id, name: record.name, description: record.description, teamId: args.teamId, pluginName: record.name });
    const landedId = await this.waitForPublishedSkill(published);
    const promotedWorkflowId = landedId != null && this.library.remove(record.id) ? landedId : null;
    if (promotedWorkflowId == null) this.options.log?.(`${LOG_PREFIX} kept the library copy of ${record.id}: commit ${published.commitSha} was not confirmed installed`);
    return { ...published, promotedWorkflowId };
  }

  async resync(args: { workflowId: string }): Promise<PublishedSkillResult & { promotedWorkflowId: null }> {
    const { record, teamId } = this.requireOwnedMarketplaceSkill(args.workflowId);
    const parsed = readSkillIdentity(record.filePath);
    // What the skill calls itself now wins, and the plugin keeps the name it was published under.
    const name = parsed.name.length > 0 ? parsed.name : record.name;
    const published = await this.publishArchive({ skillDir: dirname(record.filePath), skillRelativePath: relativeSkillPackagePath(record.skillRelativePath), name, description: parsed.description, teamId, pluginName: await requirePluginPackageName(record.installPath), displayName: name });
    await this.syncPluginIndexWithoutFailing();
    return { ...published, promotedWorkflowId: null };
  }

  async unpublish(args: { workflowId: string }): Promise<{ restoredWorkflowId: string | null }> {
    const { record, teamId } = this.requireOwnedMarketplaceSkill(args.workflowId);
    // The user gets their skill back before the plugin it came in goes away.
    const restoredWorkflowId = await this.restoreSkillToLibrary(record);
    await this.options.client.unpublishPlugin({ pluginId: record.pluginId, teamId });
    await this.syncPluginIndexWithoutFailing();
    return { restoredWorkflowId };
  }

  async restoreSkillToLibrary(record: PluginSkillRecord): Promise<string | null> {
    const skillsRoot = getGlobalWorkflowsDir(this.options.slateRootDir);
    const skillDir = dirname(record.filePath);
    const libraryId = basename(skillDir);
    if (this.library.get(libraryId) != null) return libraryId;
    const [restored] = await restoreSkillsFromPluginDir({ skillDirs: [skillDir], pluginSkillsRoot: join(record.installPath, "skills"), skillsRoot });
    return restored != null && dirname(restored) === skillsRoot ? basename(restored) : null;
  }

  async publishArchive(args: { skillDir: string; skillRelativePath: string; name: string; description: string; teamId: number; pluginName: string; displayName?: string }): Promise<PublishedSkillResult> {
    if (args.description.trim().length === 0) throw new SlateSkillPublishError("Add a description before publishing — it is how teammates and agents know when to use this skill.");
    const workDir = await mkdtemp(join(tmpdir(), "slate-publish-skill-"));
    try {
      const staged = await stageSkillDirectory({ skillDir: args.skillDir, targetDir: join(workDir, "staged") });
      const pluginDir = await writeLocalSkillPackage({
        skills: [{ sourceDirectory: staged, packagePath: args.skillRelativePath }],
        targetDirectory: join(workDir, "plugin"),
        name: args.pluginName,
        ...(args.displayName == null ? {} : { displayName: args.displayName }),
      });
      // The manifest decides the name the backend receives; a synth that named it differently is the one that counts.
      const manifestName = await readPluginPackageName(pluginDir) ?? args.pluginName;
      const packed = await packPluginArtifact(pluginDir);
      return await this.options.client.publishPlugin({
        teamId: args.teamId,
        name: manifestName,
        displayName: args.displayName ?? args.name,
        description: args.description,
        pluginArchive: new Uint8Array(packed),
      });
    } finally {
      try {
        await rm(workDir, { recursive: true, force: true });
      } catch (error) {
        this.options.log?.(`${LOG_PREFIX} failed to clean up ${workDir}: ${explainPublishFailure(error)}`);
        this.options.reportEdgeFailed?.({ stage: "cleanup", errorClass: errorLogTag(error) });
      }
    }
  }

  /** Waits for the published commit to show up in the installed index, syncing in between. */
  async waitForPublishedSkill(published: PublishedSkillResult): Promise<string | null> {
    for (let attempt = 0; attempt < CONFIRM_PUBLISH_MAX_ATTEMPTS; attempt++) {
      await this.syncPluginIndexWithoutFailing();
      const landed = this.options.pluginSkills.currentIndex()?.skills.find((record) => record.pluginId === published.pluginId && record.pluginVersion === published.commitSha && existsSync(record.filePath));
      if (landed != null) return landed.id;
    }
    return null;
  }

  requireLibraryWorkflow(workflowId: string): GlobalWorkflowRecord {
    const record = this.library.get(workflowId);
    if (record == null) throw new SlateSkillPublishError("That skill no longer exists in your library.");
    return record;
  }

  /** The plugin skill this account published, which is the only kind that may be synced or taken back. */
  requireOwnedMarketplaceSkill(workflowId: string): { record: PluginSkillRecord; teamId: number } {
    const index = this.options.pluginSkills.currentIndex();
    const record = index?.skills.find((candidate) => candidate.id === workflowId);
    if (index == null || record == null) throw new SlateSkillPublishError("That skill is no longer installed.");
    if (record.publisherUserId == null || record.publisherUserId !== index.currentUserId) throw new SlateSkillPublishError(`"${record.name}" belongs to a plugin you did not publish.`);
    if (record.marketplaceTeamId == null) throw new SlateSkillPublishError(`"${record.name}" is not in a team marketplace, so there is nothing to sync it back to.`);
    return { record, teamId: record.marketplaceTeamId };
  }

  /** A sync that failed is reported, not thrown: it happens after the work the caller asked for. */
  async syncPluginIndexWithoutFailing(): Promise<void> {
    try {
      await this.options.pluginSkills.sync("install");
    } catch (error) {
      this.options.log?.(`${LOG_PREFIX} plugin-skills sync after publish failed: ${explainPublishFailure(error)}`);
      this.options.reportEdgeFailed?.({ stage: "sync", errorClass: errorLogTag(error) });
    }
  }
}
