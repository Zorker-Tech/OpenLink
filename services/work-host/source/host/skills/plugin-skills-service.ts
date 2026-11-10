import { join } from "node:path";
import {
  getPluginSkillsDir,
  readPluginSkillsCache,
  writePluginSkillsCache,
  type PluginAuthBlock,
  type PluginSkillRecord,
  type PluginSkillsCache,
} from "./plugin-skills-cache.ts";
import type { LoadedPlugins, PluginSkillsServiceOptions } from "./plugin-skills-contracts.ts";
import {
  pluginContentsToSkillRecords,
  pruneUninstalledPluginDirs,
  skillRecordsIdentity,
} from "./plugin-skill-records.ts";
import { getPluginsRootDir } from "./plugin-skills-cache.ts";

export class SlatePluginSkillsService {
  private disposed = false;
  private inFlight: Promise<PluginSkillRecord[]> | null = null;
  private pending: { trigger: string; promise: Promise<PluginSkillRecord[]> } | null = null;

  constructor(readonly options: PluginSkillsServiceOptions) {}

  start(): void {
    this.runWithoutBlockingStartup("startup");
  }

  handleAuthChange(): void {
    this.runWithoutBlockingStartup("auth_change");
  }

  dispose(): void {
    this.disposed = true;
  }

  current(): PluginSkillRecord[] {
    return this.currentIndex()?.skills ?? [];
  }

  currentIndex(): PluginSkillsCache | null {
    return readPluginSkillsCache(getPluginSkillsDir(this.options.slateRootDir));
  }

  currentAuthBlocked(): PluginAuthBlock[] {
    return this.currentIndex()?.authBlocked ?? [];
  }

  private runWithoutBlockingStartup(trigger: string): void {
    void this.sync(trigger).catch(() => {});
  }

  async sync(trigger: string): Promise<PluginSkillRecord[]> {
    if (this.disposed) return this.current();
    if (this.inFlight == null) return this.startPass(trigger);

    if (this.pending == null) {
      const activePass = this.inFlight;
      const queuedPass = (async () => {
        try {
          await activePass;
        } catch {
          // A refresh that failed does not prevent the latest queued refresh from running.
        }
        const latestTrigger = this.pending?.trigger ?? trigger;
        this.pending = null;
        return this.disposed ? this.current() : this.startPass(latestTrigger);
      })();
      this.pending = { trigger, promise: queuedPass };
    } else {
      this.pending.trigger = trigger;
    }
    return this.pending.promise;
  }

  private startPass(trigger: string): Promise<PluginSkillRecord[]> {
    const pass = this.runPass(trigger);
    this.inFlight = pass;
    const clearCurrentPass = () => {
      if (this.inFlight === pass) this.inFlight = null;
    };
    pass.then(clearCurrentPass, clearCurrentPass);
    return pass;
  }

  private async runPass(trigger: string): Promise<PluginSkillRecord[]> {
    const now = this.options.now ?? Date.now;
    const startedAt = now();
    try {
      const loaded = await this.options.load();
      if (this.disposed) return this.current();

      const previous = this.currentIndex();
      const records = this.mergeCurrentPlugins(loaded, previous);
      writePluginSkillsCache(getPluginSkillsDir(this.options.slateRootDir), {
        currentUserId: loaded.currentUserId ?? previous?.currentUserId ?? null,
        skills: records,
        authBlocked: loaded.authBlocked,
      }, now);
      this.pruneOldPluginFolders(loaded, records);
      this.options.reportSync?.({
        trigger,
        outcome: "ok",
        changed: previous == null ? records.length > 0 : skillRecordsIdentity(previous.skills) !== skillRecordsIdentity(records),
        skillCount: records.length,
        durationMs: now() - startedAt,
      });
      return records;
    } catch (error) {
      this.options.log?.(`[slate:plugin-skills] sync (${trigger}) failed: ${error instanceof Error ? error.message : String(error)}`);
      this.options.reportSync?.({
        trigger,
        outcome: "failed",
        errorClass: error instanceof Error ? error.name : typeof error,
        durationMs: now() - startedAt,
      });
      throw error;
    }
  }

  private mergeCurrentPlugins(loaded: LoadedPlugins, previous: PluginSkillsCache | null): PluginSkillRecord[] {
    const records = pluginContentsToSkillRecords(loaded.plugins, loaded.publisherFacts);
    const listedIds = new Set(loaded.listedPluginIds);
    const installedIds = new Set(loaded.plugins.flatMap((plugin) => {
      if (plugin.loadError != null || plugin.installPath.length === 0) return [];
      const source = plugin.identifier.source;
      const pluginDbId = source === "first-party" || source === "third-party"
        ? plugin.identifier.sourceInfo.pluginDbId
        : undefined;
      return pluginDbId == null ? [] : [pluginDbId];
    }));

    return [
      ...records,
      ...(previous?.skills ?? []).filter((record) => listedIds.has(record.pluginId) && !installedIds.has(record.pluginId)),
    ];
  }

  private pruneOldPluginFolders(loaded: LoadedPlugins, records: readonly PluginSkillRecord[]): void {
    const prune = this.options.prune ?? pruneUninstalledPluginDirs;
    prune(
      join(getPluginsRootDir(this.options.slateRootDir), "cache"),
      loaded.listedCacheKeys,
      records.map((record) => record.filePath),
    );
  }
}
