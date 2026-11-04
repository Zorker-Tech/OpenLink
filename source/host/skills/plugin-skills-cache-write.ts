import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";

import { AGENT_READABLE_SKILL_DIR_MODE, AGENT_READABLE_SKILL_FILE_MODE } from "../../shared/workflow-model.ts";
import { getPluginSkillsCachePath } from "./plugin-skills-cache-paths.ts";
import type { PluginAuthBlock } from "./plugin-skills-cache-contracts.ts";

export function writePluginSkillsCache(
  cacheDir: string,
  index: { currentUserId?: number | null; skills: readonly unknown[]; authBlocked?: readonly PluginAuthBlock[] },
  now: () => number = Date.now,
): void {
  const cacheBody = `${JSON.stringify({ fetchedAt: now(), authBlocked: [], ...index }, null, 2)}\n`;
  mkdirSync(cacheDir, { recursive: true, mode: AGENT_READABLE_SKILL_DIR_MODE });
  chmodSync(cacheDir, AGENT_READABLE_SKILL_DIR_MODE);

  const cachePath = getPluginSkillsCachePath(cacheDir);
  const temporaryPath = `${cachePath}.tmp`;
  writeFileSync(temporaryPath, cacheBody, { encoding: "utf8", mode: AGENT_READABLE_SKILL_FILE_MODE });
  chmodSync(temporaryPath, AGENT_READABLE_SKILL_FILE_MODE);
  renameSync(temporaryPath, cachePath);
}
