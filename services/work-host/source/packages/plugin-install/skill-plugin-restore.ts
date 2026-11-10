/**
 * Putting back the skills a plugin brought.
 *
 * A plugin's skills live with the plugin, but the workspace reads skills from its own directories, so a plugin that was
 * removed and restored has to have its skills put back where the workspace looks for them. A skill that is already
 * there is left alone rather than overwritten, since the copy in the workspace is the one the user may have edited.
 */
import { cp, mkdir, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export interface RestoreSkillsFromPluginDirOptions {
  readonly skillDirs: readonly string[];
  readonly pluginSkillsRoot: string;
  readonly skillsRoot: string;
}

/** One skill to put back: where it is in the plugin, and where the workspace reads it from. */
interface Restore {
  readonly from: string;
  readonly to: string;
}

/** Whether something is there, without caring what it is. */
async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Whether something is there and is a directory. */
async function isFolder(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** Where a skill folder sits inside the plugin, refusing one that sits outside it. */
function insidePlugin(pluginSkillsRoot: string, skillDir: string): string {
  const path = relative(resolve(pluginSkillsRoot), resolve(skillDir));
  if (path === "" || isAbsolute(path) || path.split(sep)[0] === "..") {
    throw new Error(`Skill folder "${skillDir}" is not inside the plugin's skills directory`);
  }
  return path;
}

/** The restore plan for these folders: each one's place inside the plugin, and the workspace path it becomes. */
function plan(options: RestoreSkillsFromPluginDirOptions): Restore[] {
  const { skillDirs, pluginSkillsRoot, skillsRoot } = options;
  if (skillDirs.length === 0) throw new Error("At least one skill directory is required");
  const restores = skillDirs.map((skillDir) => ({ from: skillDir, to: join(skillsRoot, insidePlugin(pluginSkillsRoot, skillDir)) }));

  // Two folders that land on one workspace path would write over each other, so the plan is refused instead.
  const placed = new Set<string>();
  const collisions: string[] = [];
  for (const { to } of restores) {
    if (placed.has(to)) collisions.push(to);
    placed.add(to);
  }
  if (collisions.length > 0) throw new Error(`Multiple skill folders would restore to the same path: ${collisions.join(", ")}`);
  return restores;
}

/** Refuses the plan unless every folder is a folder and nothing is where it would be put. */
async function assertRestorable(restores: readonly Restore[]): Promise<void> {
  for (const { from, to } of restores) {
    if (!(await isFolder(from))) throw new Error(`Skill folder "${from}" is not a directory`);
    if (await exists(to)) throw new Error(`Cannot restore skill to "${to}": that path already exists`);
  }
}

/**
 * Puts the plugin's skills back where the workspace reads them, and answers with the paths it wrote.
 *
 * The whole plan is checked before anything is copied, so a refusal leaves the workspace as it was rather than half
 * restored.
 */
export async function restoreSkillsFromPluginDir(options: RestoreSkillsFromPluginDirOptions): Promise<string[]> {
  const restores = plan(options);
  await assertRestorable(restores);
  await mkdir(options.skillsRoot, { recursive: true });
  for (const { from, to } of restores) {
    await mkdir(dirname(to), { recursive: true });
    await cp(from, to, { recursive: true, force: false, errorOnExist: true });
  }
  return restores.map(({ to }) => to);
}
