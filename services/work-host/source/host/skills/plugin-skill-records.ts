import { readdirSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { clampWorkflowDescription, clampWorkflowName, slugifyWorkflowName } from "../../shared/workflow-model.ts";
import { getPluginInstallCachePath } from "../../packages/plugin-install/marketplace.ts";
import { classifyCloneError } from "../../packages/plugin-install/marketplace-cache.ts";
import type { PluginAuthBlock, PluginSkillRecord } from "./plugin-skills-cache.ts";
import type { InstalledPlugin, ListedCacheKey, PluginLoadFailure, PluginIdentifier, PublisherFacts } from "./plugin-skills-contracts.ts";
import type { EffectivePluginsResponse } from "../../packages/plugin-install/backend-marketplace-client.ts";

function databaseIdFor(identifier: PluginIdentifier): string | undefined {
  const hasPlatformId = identifier.source === "first-party" || identifier.source === "third-party";
  return hasPlatformId ? identifier.sourceInfo.pluginDbId : undefined;
}

export function skillRecordsIdentity(records: readonly PluginSkillRecord[]): string {
  return records
    .map((record) => record.id + "@" + record.pluginVersion)
    .sort()
    .join("\n");
}

export function toPluginSkillInfo(record: PluginSkillRecord): {
  pluginId: string;
  pluginName: string;
  name: string;
  description: string;
} {
  return {
    pluginId: record.pluginId,
    pluginName: record.pluginName,
    name: record.name,
    description: record.description,
  };
}

export function skillNameFromPath(relativePath: string): string {
  const parts = relativePath.split("/").filter(Boolean);
  const filenameIndex = parts.length - 1;
  return parts[filenameIndex - 1] ?? parts[filenameIndex] ?? "";
}

export function pluginVersionOf(identifier: PluginIdentifier): string {
  return typeof identifier.sourceInfo.version === "string" ? identifier.sourceInfo.version : "";
}

export function pluginContentsToSkillRecords(
  plugins: readonly InstalledPlugin[],
  publisherFacts: ReadonlyMap<string, PublisherFacts> = new Map(),
): PluginSkillRecord[] {
  const records: PluginSkillRecord[] = [];
  const claimedIds = new Set<string>();

  for (const installed of plugins) {
    if (installed.loadError != null || installed.installPath.length === 0) continue;
    const pluginId = databaseIdFor(installed.identifier);
    if (!pluginId) continue;
    const pluginName = installed.displayName != null && installed.displayName.length > 0
      ? installed.displayName
      : installed.identifier.sourceInfo.name;

    for (const skill of installed.skills) {
      const name = clampWorkflowName(
        skill.name != null && skill.name.length > 0 ? skill.name : skillNameFromPath(skill.path),
      );
      if (name.length === 0) continue;

      const slug = slugifyWorkflowName(name);
      const prefix = "plugin-" + pluginId + "-" + slug;
      let id = prefix;
      for (let suffix = 2; claimedIds.has(id); suffix += 1) id = prefix + "-" + suffix;
      claimedIds.add(id);

      records.push({
        id,
        pluginId,
        pluginName,
        name,
        description: clampWorkflowDescription(skill.description ?? ""),
        filePath: resolve(installed.installPath, skill.path),
        pluginVersion: pluginVersionOf(installed.identifier),
        installPath: installed.installPath,
        skillRelativePath: skill.path,
        publisherUserId: publisherFacts.get(pluginId)?.publisherUserId ?? null,
        marketplaceTeamId: publisherFacts.get(pluginId)?.marketplaceTeamId ?? null,
      });
    }
  }
  return records;
}

export function publisherFactsFromListing(response: EffectivePluginsResponse): Map<string, PublisherFacts> {
  const facts = new Map<string, PublisherFacts>();
  for (const item of response.plugins ?? []) {
    const plugin = item.plugin;
    if (plugin == null || plugin.id == null) continue;
    const owner = plugin.publisher?.ownerUserId;
    const teamId = plugin.marketplace?.teamId;
    facts.set(plugin.id.toString(), {
      publisherUserId: owner != null && owner > 0 ? owner : null,
      marketplaceTeamId: teamId != null && teamId > 0 ? teamId : null,
    });
  }
  return facts;
}

export function pluginAuthBlocksFromFailures(failures: readonly PluginLoadFailure[]): PluginAuthBlock[] {
  const blocked: PluginAuthBlock[] = [];
  const alreadyReported = new Set<string>();
  for (const failure of failures) {
    if (classifyCloneError(failure.errorMessage) !== "user_git_access") continue;
    const pluginId = failure.pluginDbId ?? failure.pluginId ?? "";
    const key = pluginId || "name:" + failure.pluginName;
    if (alreadyReported.has(key)) continue;
    alreadyReported.add(key);
    blocked.push({
      pluginId,
      pluginName: failure.pluginName,
      ...(failure.marketplaceName == null ? {} : { marketplaceName: failure.marketplaceName }),
    });
  }
  return blocked;
}

export function pruneUninstalledPluginDirs(
  cacheRoot: string,
  listed: readonly ListedCacheKey[],
  indexedFilePaths: readonly string[],
): void {
  const keepPaths = new Set(listed.map((entry) => getPluginInstallCachePath(cacheRoot, entry)));
  let marketplaceFolders;
  try {
    marketplaceFolders = readdirSync(cacheRoot, { withFileTypes: true });
  } catch {
    return;
  }

  for (const marketplaceFolder of marketplaceFolders) {
    if (!marketplaceFolder.isDirectory()) continue;
    const marketplacePath = join(cacheRoot, marketplaceFolder.name);
    let pluginFolders;
    try {
      pluginFolders = readdirSync(marketplacePath, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const pluginFolder of pluginFolders) {
      if (!pluginFolder.isDirectory()) continue;
      const pluginPath = join(marketplacePath, pluginFolder.name);
      const referenced = indexedFilePaths.some((path) => path.startsWith(pluginPath + sep));
      if (keepPaths.has(pluginPath) || referenced) continue;
      try {
        rmSync(pluginPath, { recursive: true, force: true });
      } catch {
        // A cache entry that cannot be pruned will be checked again next refresh.
      }
    }
  }
}
