/**
 * Keeping a marketplace's discovered cached.
 *
 * A marketplace is a repository of discovered, fetched once and reused: the clone is given time to finish — less for a
 * listing than for a fetch — and a failure is manifestEntry by who has to act, since a user without access, a cache that
 * two processes are racing over, and a pinned ref that no longer exists are three different problems with three
 * different answers. What a marketplace holds is read from its own files, and its path is canonicalized so the same
 * repository is one cache entry however its URL was spelled.
 */
import { randomUUID } from "node:crypto";
import { cp, mkdir, readFile, readdir, rename, rm, stat, utimes } from "node:fs/promises";
import { dirname, join } from "node:path";
import { withTimeout } from "../utils/promise-tools.ts";
import { sanitizeFilename } from "../utils/managed-paths.ts";
import { resolveGitRemoteRef } from "./git-remote-ref-resolve.ts";
import {
  isSparseCheckoutRepo,
  materializeSparseDirs,
  resolveSparseClonePlan,
  serverIgnoredFilter,
  setSparseCheckoutDirs,
  type MaterializeSpec,
} from "./git-sparse-clone.ts";
import {
  execGitNonInteractive,
  resolveExtraGitConfig,
  type ExtraGitConfigProvider,
} from "./git-subprocess-env.ts";
import { canonicalRepoHost, parseAndValidateScmUrl, parseGitUrl, toScmSshUrl } from "./git-url-parsing.ts";
import {
  MARKETPLACE_MANIFEST_PATHS,
  isPathSafe,
  parseAndClassifyManifestEntries,
  parseMarketplaceManifest,
  resolvePluginSourcePath,
  type MarketplaceManifest,
} from "./manifest-parser.ts";
import { noopPluginMetricsLogger, type PluginMetricsLogger } from "./types.ts";
import { validateAndResolveSubpath } from "./validate-subpath.ts";

const WINDOWS_RESERVED_PATH_NAMES = new Set(["con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9"]);
export const LS_REMOTE_TIMEOUT_MS = 30_000;
export const REMOTE_GIT_TIMEOUT_MS = 30 * 60_000;
export const LOCAL_GIT_TIMEOUT_MS = 10 * 60_000;
const RECURSIVE_RM_OPTIONS = { recursive: true, force: true, maxRetries: 3 } as const;
const USER_GIT_ACCESS_PATTERNS = ["terminal prompts disabled", "could not read username", "host key verification failed", "could not read from remote repository", "permission denied", "repository not found", "user cancelled dialog", "spawn git enoent", "authentication failed", "unable to get password from user"] as const;
const LOCAL_CACHE_PATTERNS = ["enotempty: directory not empty, rename", "/_staging/"] as const;
const STALE_PINNED_REF_PATTERNS = ["upload-pack: not our ref", "server does not allow request for unadvertised object"] as const;
const globalInFlight = new Map<string, Promise<unknown>>();

/** Whether a text says one of the things a pattern list names. */
function says(text: string, patterns: readonly string[]): boolean {
  return patterns.some(pattern => text.includes(pattern));
}

/** A name turned into one path segment: no trailing dots or spaces, and never a reserved Windows name. */
function safeSegment(raw: string): string {
  const segment = sanitizeFilename(raw).replace(/[. ]+$/g, "");
  if (segment === "" || segment === "." || segment === "..") return "_";
  return WINDOWS_RESERVED_PATH_NAMES.has(segment.toLowerCase()) ? `_${segment}` : segment;
}

export type CloneErrorCategory = "user_git_access" | "local_cache_race" | "stale_pinned_ref" | "infrastructure";
export function classifyCloneError(error: unknown): CloneErrorCategory {
  const text = String(error).toLowerCase().replaceAll("\\", "/");
  if (says(text, USER_GIT_ACCESS_PATTERNS)) return "user_git_access";
  if (LOCAL_CACHE_PATTERNS.every(pattern => text.includes(pattern))) return "local_cache_race";
  if (says(text, STALE_PINNED_REF_PATTERNS)) return "stale_pinned_ref";
  return "infrastructure";
}

export function isKilledSubprocessError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const failure = error as { killed?: unknown; cause?: unknown };
  return failure.killed === true || isKilledSubprocessError(failure.cause);
}

function errorTagOf(error: unknown): CloneErrorCategory | "killed_by_budget" { return isKilledSubprocessError(error) ? "killed_by_budget" : classifyCloneError(error); }

/** The lower-cased segments a gitlab URL names, or nothing when the URL is not one. */
function gitLabPathSegments(remoteUrl: string): string[] | undefined {
  const scmInfo = parseAndValidateScmUrl(remoteUrl);
  if ("error" in scmInfo || scmInfo.provider !== "gitlab") return undefined;
  let urlPath: string;
  try { urlPath = new URL(scmInfo.url).pathname.replace(/^\//, ""); }
  catch { throw new Error(`Invalid git URL: ${remoteUrl}`); }
  const pathSegments = urlPath.split("/").filter(Boolean).map(segment => segment.toLowerCase());
  if (pathSegments.length < 2) throw new Error(`Invalid git URL: ${remoteUrl}`);
  return pathSegments;
}

export function getCanonicalMarketplacePathSegments(remoteUrl: string): { host: string; pathSegments: string[] } {
  const scmInfo = parseAndValidateScmUrl(remoteUrl);
  if (!("error" in scmInfo) && scmInfo.provider === "gitlab") {
    return { host: scmInfo.host.toLowerCase(), pathSegments: gitLabPathSegments(remoteUrl)! };
  }
  const parsedUrl = parseGitUrl(remoteUrl);
  if (parsedUrl === null) throw new Error(`Invalid git URL: ${remoteUrl}`);
  return { host: canonicalRepoHost(parsedUrl.host.replace(/^www\./i, "")).toLowerCase(), pathSegments: [parsedUrl.owner.toLowerCase(), parsedUrl.repo.toLowerCase()] };
}

function cacheKeyOf(checkoutPath: string, settings: { repoName?: string; fallbackId?: string }): string {
  return JSON.stringify({ checkoutPath, repoName: settings.repoName ?? null, fallbackId: settings.fallbackId ?? null });
}

async function readManifestInDir(dir: string, settings: { repoName?: string; fallbackId?: string } = {}): Promise<MarketplaceManifest | null> {
  for (const manifestRelPath of MARKETPLACE_MANIFEST_PATHS) {
    let content: string;
    try { content = await readFile(join(dir, manifestRelPath), "utf-8"); }
    catch { continue; }
    const result = parseMarketplaceManifest(content, settings);
    if (result.success) return result.data;
  }
  return null;
}

export interface DiscoveredMarketplacePlugin {
  name: string;
  displayName?: string | undefined;
  description?: string | undefined;
  version?: string | undefined;
  sourceType: "local" | "github" | "url" | "git-subdir";
  gitPath?: string;
  gitUrl?: string;
  gitRef?: string | undefined;
  sha?: string | undefined;
  subdirPath?: string;
}

function pluginsInManifest(manifest: MarketplaceManifest): DiscoveredMarketplacePlugin[] {
  const discovered: DiscoveredMarketplacePlugin[] = [];
  for (const manifestEntry of parseAndClassifyManifestEntries(manifest.plugins, manifest.metadata?.pluginRoot)) {
    const { name, displayName, description, version } = manifestEntry.entry;
    const sharedFields = { name, displayName, description, version };
    switch (manifestEntry.kind) {
      case "local": if (isPathSafe(manifestEntry.localPath)) discovered.push({ ...sharedFields, sourceType: "local", gitPath: manifestEntry.localPath }); break;
      case "external-github": discovered.push({ ...sharedFields, sourceType: "github", gitUrl: manifestEntry.externalUrl, gitRef: manifestEntry.externalRef, sha: manifestEntry.externalSha }); break;
      case "external-url": discovered.push({ ...sharedFields, sourceType: "url", gitUrl: manifestEntry.externalUrl, gitRef: manifestEntry.externalRef, sha: manifestEntry.externalSha }); break;
      case "external-git-subdir": discovered.push({ ...sharedFields, sourceType: "git-subdir", gitUrl: manifestEntry.externalUrl, gitRef: manifestEntry.externalRef, sha: manifestEntry.externalSha, subdirPath: manifestEntry.subdirPath }); break;
      case "unresolvable": break;
    }
  }
  return discovered;
}

export interface MarketplaceCacheOptions {
  readonly extraGitConfig?: ExtraGitConfigProvider;
  readonly sparsePluginClones?: boolean;
}

interface CloneStrategy { strategy: "sparse" | "full"; filterIgnoredByServer: boolean }

export class MarketplaceCacheManager {
  static STALE_STAGING_THRESHOLD_MS = 5 * 60 * 1_000;
  static STAGING_HEARTBEAT_INTERVAL_MS = 60 * 1_000;
  readonly manifestCache = new Map<string, MarketplaceManifest | null>();

  constructor(readonly cacheRoot: string, readonly options?: MarketplaceCacheOptions) {}

  get sparsePluginClones(): boolean { return this.options?.sparsePluginClones ?? false; }
  private fetchTimeoutMs(): number | undefined { return this.sparsePluginClones ? REMOTE_GIT_TIMEOUT_MS : undefined; }
  private initTimeoutMs(): number | undefined { return this.sparsePluginClones ? LOCAL_GIT_TIMEOUT_MS : undefined; }
  private lsRemoteTimeout(): number | undefined { return this.sparsePluginClones ? LS_REMOTE_TIMEOUT_MS : undefined; }

  private async cloneRefInto(checkoutDir: string, remoteUrl: string, fullSha: string, settings?: { sshBatchMode?: boolean | undefined; materialize?: MaterializeSpec | undefined }): Promise<CloneStrategy> {
    const gitOptions = {
      cwd: checkoutDir,
      sshBatchMode: settings?.sshBatchMode,
      extraGitConfig: { ...resolveExtraGitConfig(this.options?.extraGitConfig), "safe.directory": checkoutDir },
    };
    const { sparse, sparseDirs: sparseDirectories } = await resolveSparseClonePlan(settings?.materialize ?? "all", this.sparsePluginClones);
    await execGitNonInteractive(["init"], { ...gitOptions, timeoutMs: this.initTimeoutMs() });
    if (sparse) await setSparseCheckoutDirs(checkoutDir, sparseDirectories, { sshBatchMode: settings?.sshBatchMode, extraGitConfig: resolveExtraGitConfig(this.options?.extraGitConfig), timeoutMs: this.initTimeoutMs() });
    const { stderr: fetchErrorOutput } = await execGitNonInteractive(["fetch", "--depth", "1", ...(sparse ? ["--filter=blob:none"] : []), remoteUrl, fullSha], { ...gitOptions, timeoutMs: this.fetchTimeoutMs() });
    await execGitNonInteractive(["checkout", "FETCH_HEAD"], { ...gitOptions, timeoutMs: this.fetchTimeoutMs() });
    return { strategy: sparse ? "sparse" : "full", filterIgnoredByServer: sparse && serverIgnoredFilter(fetchErrorOutput ?? "") };
  }

  private async makeStagingDir(): Promise<string> { const stagingPath = join(this.cacheRoot, "_staging", randomUUID()); await mkdir(stagingPath, { recursive: true }); return stagingPath; }
  private async promoteStagingDir(stagingPath: string, checkoutDir: string): Promise<string> { await mkdir(dirname(checkoutDir), { recursive: true }); await rm(checkoutDir, RECURSIVE_RM_OPTIONS); await rename(stagingPath, checkoutDir); return checkoutDir; }
  private async sweepStaleStaging(): Promise<void> {
    const stagingRoot = join(this.cacheRoot, "_staging");
    try {
      const listed = await readdir(stagingRoot, { withFileTypes: true }), clockReading = Date.now();
      await Promise.all(listed.filter(pluginEntry => pluginEntry.isDirectory()).map(async pluginEntry => {
        try { const entryPath = join(stagingRoot, pluginEntry.name), fileStats = await stat(entryPath); if (clockReading - fileStats.mtimeMs > MarketplaceCacheManager.STALE_STAGING_THRESHOLD_MS) await rm(entryPath, RECURSIVE_RM_OPTIONS); } catch {}
      }));
    } catch {}
  }

  getLegacyCloneDir(sourceId: string, ref: string): string { return join(this.cacheRoot, safeSegment(sourceId), safeSegment(ref)); }
  getCanonicalCloneDir(remoteUrl: string, ref: string): string { const { host, pathSegments } = getCanonicalMarketplacePathSegments(remoteUrl); return join(this.cacheRoot, safeSegment(host), ...pathSegments.map(safeSegment), safeSegment(ref)); }
  getCanonicalRepoRootDir(remoteUrl: string): string { const { host, pathSegments } = getCanonicalMarketplacePathSegments(remoteUrl); return join(this.cacheRoot, safeSegment(host), ...pathSegments.map(safeSegment)); }

  private async removeSiblingClones(remoteUrl: string, keptRef: string, oldCloneDir?: string): Promise<void> {
    const repositoryRoot = this.getCanonicalRepoRootDir(remoteUrl), keepDirName = safeSegment(keptRef);
    try { const listed = await readdir(repositoryRoot, { withFileTypes: true }); await Promise.all(listed.filter(pluginEntry => pluginEntry.isDirectory() && pluginEntry.name !== keepDirName).map(pluginEntry => rm(join(repositoryRoot, pluginEntry.name), RECURSIVE_RM_OPTIONS))); } catch {}
    if (oldCloneDir !== undefined) try { await rm(oldCloneDir, RECURSIVE_RM_OPTIONS); } catch {}
  }

  async ensureCloned(sourceId: string, remoteUrl: string, ref: string, metricsLogger: PluginMetricsLogger = noopPluginMetricsLogger, settings?: { materialize?: MaterializeSpec | undefined }): Promise<string> {
    const inner = this.serializedForRepo(this.getCanonicalRepoRootDir(remoteUrl), () => this.ensureClonedOnce(sourceId, remoteUrl, ref, metricsLogger, settings?.materialize ?? "all"));
    return this.sparsePluginClones ? inner : withTimeout(inner, 30_000, `ensureCloned timed out after 30000ms for ${remoteUrl} @ ${ref}`);
  }

  async ensureMaterialized(checkoutPath: string, requestedDirs: MaterializeSpec, metricsLogger: PluginMetricsLogger = noopPluginMetricsLogger): Promise<void> {
    const inner = this.serializedForRepo(dirname(checkoutPath), async () => {
      const startedAt = performance.now();
      try {
        await materializeSparseDirs(checkoutPath, requestedDirs, { extraGitConfig: resolveExtraGitConfig(this.options?.extraGitConfig), timeoutMs: this.fetchTimeoutMs() });
        metricsLogger.increment("marketplace_cache_manager.ensure_materialized.success", 1);
        metricsLogger.distribution("marketplace_cache_manager.ensure_materialized.duration", performance.now() - startedAt);
      } catch (error) {
        metricsLogger.log("error", "Failed to materialize plugin directories in sparse marketplace clone", { clonePath: checkoutPath, spec: requestedDirs === "all" ? "all" : requestedDirs.join(","), error: String(error), errorCategory: errorTagOf(error) });
        metricsLogger.increment("marketplace_cache_manager.ensure_materialized.error", 1, { error_category: errorTagOf(error) });
        metricsLogger.distribution("marketplace_cache_manager.ensure_materialized.duration", performance.now() - startedAt, { cloneResult: "error" });
        throw error;
      }
    });
    return this.sparsePluginClones ? inner : withTimeout(inner, 30_000, `ensureMaterialized timed out after 30000ms for ${checkoutPath}`);
  }

  private async serializedForRepo<Value>(repositoryRoot: string, task: () => Promise<Value>): Promise<Value> {
    const queueKey = `${this.cacheRoot}:${repositoryRoot}`, previousWork = globalInFlight.get(queueKey);
    const thisWork = (previousWork ?? Promise.resolve()).catch(() => {}).then(task);
    globalInFlight.set(queueKey, thisWork);
    try { return await thisWork; }
    finally { if (globalInFlight.get(queueKey) === thisWork) globalInFlight.delete(queueKey); }
  }

  private async ensureClonedOnce(sourceId: string, remoteUrl: string, ref: string, metricsLogger: PluginMetricsLogger, materialize: MaterializeSpec): Promise<string> {
    metricsLogger.log("info", `MarketplaceCacheManager: Ensuring cloned ${sourceId} at ${remoteUrl}@${ref}`, { marketplaceId: sourceId, gitUrl: remoteUrl, ref });
    const requestedRef = ref.trim();
    let sshUrl = !remoteUrl.startsWith("git@") && !remoteUrl.startsWith("ssh://") ? toScmSshUrl(remoteUrl) : null;
    let fullSha: string;
    if (sshUrl !== null) {
      try { fullSha = (await resolveGitRemoteRef(sshUrl, requestedRef, { sshBatchMode: true, extraGitConfig: resolveExtraGitConfig(this.options?.extraGitConfig), timeoutMs: this.lsRemoteTimeout() })).fullSha; }
      catch (error) {
        if (this.sparsePluginClones && isKilledSubprocessError(error)) throw error;
        metricsLogger.log("error", "Failed to resolve remote ref using SSH URL, falling back to HTTPS", { gitUrl: remoteUrl, ref, error: String(error), errorCategory: classifyCloneError(error) });
        sshUrl = null;
        fullSha = (await resolveGitRemoteRef(remoteUrl, requestedRef, { extraGitConfig: resolveExtraGitConfig(this.options?.extraGitConfig), timeoutMs: this.lsRemoteTimeout() })).fullSha;
      }
    } else fullSha = (await resolveGitRemoteRef(remoteUrl, requestedRef, { extraGitConfig: resolveExtraGitConfig(this.options?.extraGitConfig), timeoutMs: this.lsRemoteTimeout() })).fullSha;
    const checkoutDir = this.getCanonicalCloneDir(remoteUrl, fullSha), oldCloneDir = this.getLegacyCloneDir(sourceId, requestedRef);
    metricsLogger.log("info", `MarketplaceCacheManager: Resolved clone directory for ${sourceId} at ${remoteUrl}@${ref} to ${checkoutDir}`, { marketplaceId: sourceId, resolvedRef: fullSha, originalRef: requestedRef });
    const startedAt = performance.now();
    const emitMetric = (suffix: string, tags?: Record<string, string>): void => { metricsLogger.increment(`marketplace_cache_manager.ensure_cloned.${suffix}`, 1, tags); metricsLogger.distribution(`marketplace_cache_manager.ensure_cloned.${suffix}.duration`, performance.now() - startedAt, tags); };
    if (await this.isCloneComplete(checkoutDir)) {
      await this.removeSiblingClones(remoteUrl, fullSha, oldCloneDir);
      const cachedCloneIsSparse = await isSparseCheckoutRepo(checkoutDir);
      if (cachedCloneIsSparse) await materializeSparseDirs(checkoutDir, materialize, { extraGitConfig: resolveExtraGitConfig(this.options?.extraGitConfig), timeoutMs: this.fetchTimeoutMs() });
      emitMetric("cache_hit", { strategy: cachedCloneIsSparse ? "sparse" : "full" });
      return checkoutDir;
    }
    metricsLogger.increment("marketplace_cache_manager.ensure_cloned.cache_miss", 1);
    return this.cloneThroughStaging(checkoutDir, remoteUrl, sshUrl, fullSha, oldCloneDir, ref, metricsLogger, emitMetric, materialize);
  }

  private async cloneThroughStaging(checkoutDir: string, remoteUrl: string, sshUrl: string | null, fullSha: string, oldCloneDir: string, ref: string, metricsLogger: PluginMetricsLogger, emitMetric: (suffix: string, tags?: Record<string, string>) => void, materialize: MaterializeSpec): Promise<string> {
    await this.sweepStaleStaging();
    const stagingPath = await this.makeStagingDir();
    metricsLogger.log("info", `MarketplaceCacheManager: Cloning ${remoteUrl}@${ref} into staging directory: ${stagingPath}`, { gitUrl: remoteUrl, ref, cloneDir: checkoutDir });
    const heartbeatTimer = this.sparsePluginClones ? setInterval(() => { const clockReading = new Date(); void utimes(stagingPath, clockReading, clockReading).catch(() => {}); }, MarketplaceCacheManager.STAGING_HEARTBEAT_INTERVAL_MS) : undefined;
    heartbeatTimer?.unref?.();
    try {
      let cloneResult: CloneStrategy;
      if (sshUrl !== null) {
        try { cloneResult = await this.cloneRefInto(stagingPath, sshUrl, fullSha, { sshBatchMode: true, materialize }); }
        catch (error) {
          if (this.sparsePluginClones && isKilledSubprocessError(error)) throw error;
          metricsLogger.log("error", "Falling back to HTTPS clone due to SSH clone failure", { gitUrl: remoteUrl, ref, error: String(error), errorCategory: errorTagOf(error) });
          await rm(stagingPath, RECURSIVE_RM_OPTIONS); await mkdir(stagingPath, { recursive: true });
          cloneResult = await this.cloneRefInto(stagingPath, remoteUrl, fullSha, { materialize });
        }
      } else cloneResult = await this.cloneRefInto(stagingPath, remoteUrl, fullSha, { materialize });
      if (cloneResult.filterIgnoredByServer) { metricsLogger.log("warn", "Server ignored --filter=blob:none; sparse clone downloaded a full pack", { gitUrl: remoteUrl, ref }); metricsLogger.increment("marketplace_cache_manager.ensure_cloned.filter_ignored_by_server", 1); }
      const resultDir = await this.promoteStagingDir(stagingPath, checkoutDir);
      await this.removeSiblingClones(remoteUrl, fullSha, oldCloneDir);
      emitMetric("cache_write_success", { strategy: cloneResult.strategy });
      return resultDir;
    } catch (error) {
      const errorCategory = errorTagOf(error); emitMetric("error", { error_category: errorCategory });
      metricsLogger.log("error", "Failed to clone marketplace repository via staging clone", { remoteUrl, ref, error: String(error), errorCategory });
      metricsLogger.captureException(error, { error_type: "clone_marketplace_repository", error_category: errorCategory });
      throw error;
    } finally {
      if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer);
      try { await rm(stagingPath, RECURSIVE_RM_OPTIONS); } catch {}
    }
  }

  async isCloneComplete(checkoutDir: string): Promise<boolean> {
    try {
      const fileStats = await stat(checkoutDir); if (!fileStats.isDirectory()) return false;
      const listed = await readdir(checkoutDir); if (!listed.includes(".git")) return false; if (listed.length > 1) return true;
      try { return (await stat(join(checkoutDir, ".git", "info", "sparse-checkout"))).isFile(); } catch { return false; }
    } catch { return false; }
  }

  getPluginDir(checkoutPath: string, relativePluginPath: string): string { return validateAndResolveSubpath(checkoutPath, relativePluginPath); }
  async copyPluginToDir(pluginPath: string, destinationDir: string): Promise<void> { await mkdir(destinationDir, { recursive: true }); await cp(pluginPath, destinationDir, { recursive: true, verbatimSymlinks: true }); }

  async readManifest(checkoutPath: string, settings: { repoName?: string; fallbackId?: string } = {}): Promise<MarketplaceManifest | null> {
    const manifestKey = cacheKeyOf(checkoutPath, settings);
    if (this.manifestCache.has(manifestKey)) return this.manifestCache.get(manifestKey) ?? null;
    const manifest = await readManifestInDir(checkoutPath, settings); this.manifestCache.set(manifestKey, manifest); return manifest;
  }

  async resolvePluginPath(checkoutPath: string, requestedPluginName: string): Promise<string | null> {
    const manifest = await this.readManifest(checkoutPath); if (!manifest) return null;
    const pluginEntry = manifest.plugins.find(plugin => plugin.name === requestedPluginName.toLowerCase()); if (!pluginEntry) return null;
    const resolvedSource = resolvePluginSourcePath(pluginEntry.source, manifest.metadata?.pluginRoot);
    return resolvedSource && isPathSafe(resolvedSource) ? resolvedSource : null;
  }

  async discoverPlugins(checkoutPath: string): Promise<DiscoveredMarketplacePlugin[]> {
    const manifest = await this.readManifest(checkoutPath); return manifest ? pluginsInManifest(manifest) : [];
  }
}