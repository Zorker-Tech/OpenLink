/**
 * The plugins the backend says a user has, and how one of them is installed.
 *
 * A user's plugins are decided by a service — this platform's own backend or a marketplace the user added — and the
 * answer is read, not trusted: a response written by an older or newer service is normalized, a plugin that cannot be
 * resolved is reported as a failure of its own rather than taking the list down with it, and a marketplace is resolved
 * to the repository and commit an install will fetch.
 *
 * Installing a resolved entry takes one of three named routes. An inline manifest is written out as a plugin directory,
 * a release asset is downloaded, checked and unpacked, and a repository is cloned at the commit the listing named. The
 * routes share the staging discipline: work in a temporary directory, then copy into place.
 */
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { debuglog } from "node:util";
import { extract } from "tar";
import { toScmSshUrl } from "./git-url-parsing.ts";
import { resolveGitRemoteRef } from "./git-remote-ref-resolve.ts";
import { execGitNonInteractive, resolveExtraGitConfig, type ExtraGitConfig, type ExtraGitConfigProvider } from "./git-subprocess-env.ts";
import { materializeSparseDirs, materializeSpecForGitPaths, resolveSparseClonePlan, serverIgnoredFilter, setSparseCheckoutDirs, type MaterializeSpec } from "./git-sparse-clone.ts";
import { getCanonicalMarketplacePathSegments, isKilledSubprocessError, LOCAL_GIT_TIMEOUT_MS, LS_REMOTE_TIMEOUT_MS, MarketplaceCacheManager, REMOTE_GIT_TIMEOUT_MS, type MarketplaceCacheOptions } from "./marketplace-cache.ts";
import { getReleasePluginSource } from "./cloud-manifest.ts";
import { containsPluginRootDir, isPathSafe, MARKETPLACE_MANIFEST_PATHS, parseMarketplaceManifest, resolvePluginSourcePath } from "./manifest-parser.ts";
import { validateAndResolveSubpath } from "./validate-subpath.ts";
import { synthesizeInlinePluginDir } from "./inline-plugin-synthesizer.ts";
import { noopPluginMetricsLogger, type PluginMetricsLogger } from "./types.ts";

/** The debug namespace this module traces under. */
const trace = debuglog("slate-plugins");

/** The two source schemes a listed entry can name: a repository at a ref, or a release asset. */
const REPOSITORY_SOURCE_SCHEME = "backend-git://";
const RELEASE_SOURCE_SCHEME = "backend-release://";

/** A ref this short and this hexadecimal is taken as a commit, not as a branch or tag. */
const COMMIT_REF_PATTERN = /^[0-9a-f]{7,40}$/i;

/** What a release may cost before it is refused, at download and again once unpacked. */
const RELEASE_ASSET_LIMIT_BYTES = 100 * 1024 * 1024;
const UNPACKED_ARCHIVE_LIMIT_BYTES = 500 * 1024 * 1024;
const ARCHIVE_ENTRY_LIMIT = 50_000;
const ARCHIVE_RATIO_LIMIT = 100;

// ---------------------------------------------------------------------------------------------
// The effective user's answer, as the backend states it
// ---------------------------------------------------------------------------------------------

/** A marketplace as the backend describes it. Kept open: a newer service may say more than this client reads. */
export interface EffectiveMarketplace {
  name?: string;
  id?: string | number | bigint;
  gitRef?: string;
  gitUrl?: string;
  distributionGitUrl?: string;
  [key: string]: unknown;
}

/** A plugin definition as the backend describes it: where it comes from and which release, if either. */
export interface EffectivePluginDefinition {
  name?: string;
  id?: string | number | bigint;
  updatedAt?: string | number | bigint;
  gitRef?: string;
  gitUrl?: string;
  gitPath?: string;
  releaseRepo?: string;
  releaseAsset?: string;
  releaseTag?: string;
  marketplaceId?: string | number | bigint;
  marketplace?: EffectiveMarketplace | null;
}

/** One plugin the backend says the user has, with the user's own configuration of it. */
export interface EffectivePlugin {
  isEnabled?: boolean;
  isTeamRequired?: boolean;
  pinnedGitRef?: string;
  inlineContentJson?: string;
  configuredVariables?: unknown;
  plugin?: EffectivePluginDefinition | null;
}

/** The answer as a whole: plugins, the marketplaces they came from, and room for fields this client does not read. */
export interface EffectivePluginsResponse {
  plugins?: readonly EffectivePlugin[];
  marketplaces?: readonly EffectiveMarketplace[];
  [key: string]: unknown;
}

/** Whether a value would survive a JSON round trip as an object: non-null, not an array. */
function isJsonObject(value: unknown): boolean {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** A configured variable may arrive with its own serializer; it is asked, and a failed ask leaves the row untouched. */
function normalizeConfiguredVariables(row: EffectivePlugin): EffectivePlugin {
  const configured = row.configuredVariables;
  if (configured === undefined || configured === null) return row;
  if (typeof configured !== "object") return row;
  if (typeof (configured as { toJson?: unknown }).toJson !== "function") return row;
  let serialized: unknown;
  try {
    serialized = (configured as { toJson: () => unknown }).toJson();
  } catch {
    return row;
  }
  return { ...row, configuredVariables: isJsonObject(serialized) ? serialized : undefined };
}

/** A backend answer read into what the rest of the platform works with, leaving any answer it cannot normalize alone. */
export function normalizeEffectiveUserPluginsResponse<Response extends { plugins?: unknown }>(response: Response): Response {
  const plugins = response.plugins;
  if (!Array.isArray(plugins) || plugins.length === 0) return response;
  const normalized = plugins.map(pluginRow => normalizeConfiguredVariables(pluginRow as EffectivePlugin));
  return { ...response, plugins: normalized };
}

// ---------------------------------------------------------------------------------------------
// Reading one effective plugin
// ---------------------------------------------------------------------------------------------

/** The name a listed plugin installs under: its display name when it has one, the id it falls back to otherwise. */
function installNameFor(name: string | undefined, fallback: string): string {
  const trimmed = name?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : fallback;
}

/** The marketplace a plugin definition names: the one embedded in it, or the one its id points at. */
function marketplaceForPlugin(
  definition: EffectivePluginDefinition | null | undefined,
  marketplaces: readonly EffectiveMarketplace[] | undefined,
): EffectiveMarketplace | null | undefined {
  if (definition?.marketplace !== undefined) return definition.marketplace;
  if (definition?.marketplaceId === undefined) return undefined;
  return (marketplaces ?? []).find(candidate => candidate.id !== undefined && String(candidate.id) === String(definition.marketplaceId));
}

/** The repository an install fetches: the marketplace's distribution mirror, unless it is a different repository. */
function installGitUrl(pluginGitUrl: string, marketplace: EffectiveMarketplace | null | undefined): string {
  const mirrorUrl = marketplace?.distributionGitUrl?.trim();
  if (!mirrorUrl) return pluginGitUrl;
  if (marketplace?.gitUrl && !sameRepository(pluginGitUrl, marketplace.gitUrl)) return pluginGitUrl;
  return mirrorUrl;
}

/** The repository a marketplace's own clone comes from: the distribution mirror, or the marketplace's repository. */
function marketplaceCloneGitUrl(marketplace: EffectiveMarketplace | null | undefined): string | undefined {
  const mirrorUrl = marketplace?.distributionGitUrl?.trim();
  return mirrorUrl || marketplace?.gitUrl;
}

/** The ref an install fetches when the plugin pins nothing itself: the plugin's ref, then the marketplace's. */
function pluginRef(effective: EffectivePlugin, marketplaces: readonly EffectiveMarketplace[] | undefined): string {
  if (effective.pinnedGitRef) return effective.pinnedGitRef;
  const definition = effective.plugin;
  if (definition?.gitRef) return definition.gitRef;
  const marketplace = marketplaceForPlugin(definition, marketplaces);
  const pluginGitUrl = definition?.gitUrl;
  const marketplaceGitUrl = marketplace?.gitUrl;
  const marketplaceRefApplies = !(pluginGitUrl && marketplaceGitUrl && pluginGitUrl !== marketplaceGitUrl) && marketplace?.gitRef;
  return marketplaceRefApplies ? marketplace!.gitRef! : "main";
}

// ---------------------------------------------------------------------------------------------
// Source URLs: how a listing names what an install should fetch
// ---------------------------------------------------------------------------------------------

/** A repository source URL: the encoded repository and ref, with an encoded plugin path as an optional fragment. */
function encodeRepositorySource(gitUrl: string, ref: string, gitPath?: string): string {
  const location = `${encodeURIComponent(gitUrl)}@${encodeURIComponent(ref)}`;
  return gitPath ? `${REPOSITORY_SOURCE_SCHEME}${location}#${encodeURIComponent(gitPath)}` : `${REPOSITORY_SOURCE_SCHEME}${location}`;
}

/** A repository source URL read back, or null when the URL names another scheme. */
function decodeRepositorySource(downloadUrl: string): { gitUrl: string; ref: string; gitPath?: string | undefined } | null {
  if (!downloadUrl.startsWith(REPOSITORY_SOURCE_SCHEME)) return null;
  const remainder = downloadUrl.slice(REPOSITORY_SOURCE_SCHEME.length);
  const fragmentStart = remainder.indexOf("#");
  const location = fragmentStart >= 0 ? remainder.slice(0, fragmentStart) : remainder;
  const atIndex = location.lastIndexOf("@");
  if (atIndex < 0) return null;
  const fragment = fragmentStart >= 0 ? remainder.slice(fragmentStart + 1) : undefined;
  const gitPath = fragment ? decodeURIComponent(fragment) : undefined;
  return {
    gitUrl: decodeURIComponent(location.slice(0, atIndex)),
    ref: decodeURIComponent(location.slice(atIndex + 1)),
    gitPath,
  };
}

/** A release source URL: the encoded repository and asset, with an encoded release tag as an optional suffix. */
function encodeReleaseSource(options: { repo: string; asset: string; tag?: string }): string {
  const location = `${encodeURIComponent(options.repo)}#${encodeURIComponent(options.asset)}`;
  return options.tag ? `${RELEASE_SOURCE_SCHEME}${location}@${encodeURIComponent(options.tag)}` : `${RELEASE_SOURCE_SCHEME}${location}`;
}

/** A release source URL read back, or null when the URL names another scheme or is missing its asset. */
function decodeReleaseSource(downloadUrl: string): { repo: string; asset: string; tag?: string | undefined } | null {
  if (!downloadUrl.startsWith(RELEASE_SOURCE_SCHEME)) return null;
  const remainder = downloadUrl.slice(RELEASE_SOURCE_SCHEME.length);
  const hashIndex = remainder.indexOf("#");
  if (hashIndex < 0) return null;
  const repo = decodeURIComponent(remainder.slice(0, hashIndex));
  const afterHash = remainder.slice(hashIndex + 1);
  const atIndex = afterHash.lastIndexOf("@");
  if (atIndex < 0) return { repo, asset: decodeURIComponent(afterHash), tag: undefined };
  return {
    repo,
    asset: decodeURIComponent(afterHash.slice(0, atIndex)),
    tag: decodeURIComponent(afterHash.slice(atIndex + 1)),
  };
}

/** A repository reduced to the host and path segments that identify it, or null when it cannot be read as one. */
function repositoryIdentity(gitUrl: string): string | null {
  try {
    const segments = getCanonicalMarketplacePathSegments(gitUrl);
    return segments.host + "\0" + segments.pathSegments.join("\0");
  } catch {
    return null;
  }
}

/** Whether two spellings name the same repository, by trimmed text first and by canonical identity second. */
function sameRepository(left: string, right: string): boolean {
  if (left.trim() === right.trim()) return true;
  const leftIdentity = repositoryIdentity(left);
  const rightIdentity = repositoryIdentity(right);
  return leftIdentity !== null && leftIdentity === rightIdentity;
}

// ---------------------------------------------------------------------------------------------
// Finding a plugin's directory inside a clone
// ---------------------------------------------------------------------------------------------

/** One answer to "where in this clone is the plugin": resolved, unexplained, or no marketplace manifest at all. */
type ManifestOutcome =
  | { type: "resolved"; gitPath: string }
  | { type: "manifest-unresolved"; reason: string }
  | { type: "no-manifest" };

/** A manifest that could not answer where the plugin is, with what the caller needs to repeat the refusal. */
function manifestRefusal(reason: string): ManifestOutcome {
  return { type: "manifest-unresolved", reason };
}

/** The text of a marketplace manifest in a clone, or null when this clone has no manifest at that path. */
async function readMarketplaceManifest(cloneDir: string, manifestRelativePath: string): Promise<string | null> {
  try {
    return await readFile(join(cloneDir, manifestRelativePath), "utf-8");
  } catch {
    return null;
  }
}

/** The plugin's directory, read from the first marketplace manifest the clone carries. */
async function derivePluginGitPath(cloneDir: string, pluginName: string): Promise<ManifestOutcome> {
  for (const manifestRelativePath of MARKETPLACE_MANIFEST_PATHS) {
    const content = await readMarketplaceManifest(cloneDir, manifestRelativePath);
    if (content === null) continue;
    const parsed = parseMarketplaceManifest(content);
    if (!parsed.success) return manifestRefusal(`Invalid marketplace manifest at ${manifestRelativePath}: ${parsed.error}`);
    const namedPlugin = parsed.data.plugins.find(candidate => candidate.name === pluginName.toLowerCase());
    if (namedPlugin === undefined) return manifestRefusal(`Plugin ${JSON.stringify(pluginName)} not found in ${manifestRelativePath}`);
    if (typeof namedPlugin.source !== "string" && namedPlugin.source.source === "git-subdir") return manifestRefusal(`Plugin ${JSON.stringify(pluginName)} uses unsupported git-subdir source`);
    const sourcePath = resolvePluginSourcePath(namedPlugin.source, parsed.data.metadata?.pluginRoot);
    if (!sourcePath || !isPathSafe(sourcePath)) return manifestRefusal(`Plugin ${JSON.stringify(pluginName)} has unresolved or unsafe source path`);
    return { type: "resolved", gitPath: sourcePath };
  }
  return { type: "no-manifest" };
}

// ---------------------------------------------------------------------------------------------
// Cloning a repository at a ref
// ---------------------------------------------------------------------------------------------

/** How long each half of the clone may take: remote operations one window, local ones another. */
interface CloneTimeouts {
  readonly remoteMs: number | undefined;
  readonly localMs: number | undefined;
}

/** The clone timeouts for this run: a sparse plugin clone is bounded, an ordinary one is not. */
function cloneTimeouts(sparsePluginClones: boolean): CloneTimeouts {
  return sparsePluginClones
    ? { remoteMs: REMOTE_GIT_TIMEOUT_MS, localMs: LOCAL_GIT_TIMEOUT_MS }
    : { remoteMs: undefined, localMs: undefined };
}

/** The extra arguments a sparse clone carries, empty for a full clone. */
function sparseCloneArguments(sparse: boolean): string[] {
  return sparse ? ["--filter=blob:none", "--sparse"] : [];
}

/** Clone a repository at a branch, tag or HEAD, then narrow it to the plugin's sparse directories when asked. */
async function cloneAtRef(
  cloneUrl: string,
  ref: string,
  targetDir: string,
  gitConfig: ExtraGitConfig,
  timeouts: CloneTimeouts,
  sparseArgs: string[],
  batchMode: boolean | undefined,
  narrowToSparseDirs: (timeoutMs: number | undefined) => Promise<void>,
): Promise<string> {
  const { stderr } = await execGitNonInteractive(["clone", "--depth", "1", "--branch", ref, ...sparseArgs, cloneUrl, targetDir], { extraGitConfig: gitConfig, timeoutMs: timeouts.remoteMs, sshBatchMode: batchMode });
  await narrowToSparseDirs(timeouts.remoteMs);
  return stderr;
}

/** Clone a repository with HEAD as the only branch, then narrow it to the plugin's sparse directories when asked. */
async function cloneAtHead(
  cloneUrl: string,
  targetDir: string,
  gitConfig: ExtraGitConfig,
  timeouts: CloneTimeouts,
  sparseArgs: string[],
  batchMode: boolean | undefined,
  narrowToSparseDirs: (timeoutMs: number | undefined) => Promise<void>,
): Promise<string> {
  const { stderr } = await execGitNonInteractive(["clone", "--depth", "1", ...sparseArgs, cloneUrl, targetDir], { extraGitConfig: gitConfig, timeoutMs: timeouts.remoteMs, sshBatchMode: batchMode });
  await narrowToSparseDirs(timeouts.remoteMs);
  return stderr;
}

/** Clone a repository at one commit: initialize, add the remote, fetch only that commit, check it out. */
async function cloneAtCommit(
  cloneUrl: string,
  ref: string,
  targetDir: string,
  gitConfig: ExtraGitConfig,
  timeouts: CloneTimeouts,
  sparseFilterArguments: string[],
  batchMode: boolean | undefined,
  narrowToSparseDirs: (timeoutMs: number | undefined) => Promise<void>,
): Promise<string> {
  await execGitNonInteractive(["init"], { cwd: targetDir, extraGitConfig: gitConfig, timeoutMs: timeouts.localMs });
  await execGitNonInteractive(["remote", "add", "origin", cloneUrl], { cwd: targetDir, extraGitConfig: gitConfig, timeoutMs: timeouts.localMs });
  await narrowToSparseDirs(timeouts.localMs);
  const { stderr } = await execGitNonInteractive(["fetch", "--depth", "1", ...sparseFilterArguments, "origin", ref], { cwd: targetDir, extraGitConfig: gitConfig, timeoutMs: timeouts.remoteMs, sshBatchMode: batchMode });
  await execGitNonInteractive(["checkout", "FETCH_HEAD"], { cwd: targetDir, extraGitConfig: gitConfig, timeoutMs: timeouts.remoteMs, sshBatchMode: batchMode });
  return stderr;
}

/** Whether the URL already names an ssh transport, which needs no ssh rewrite. */
function isSshUrl(gitUrl: string): boolean {
  return gitUrl.startsWith("git@") || gitUrl.startsWith("ssh://");
}

/**
 * Clone a repository into a directory, over ssh first when it can be spelled that way, and fall back to the URL the
 * listing gave when the ssh form cannot be reached. A killed subprocess under sparse cloning is the caller's to see.
 */
async function shallowClone(
  gitUrl: string,
  ref: string,
  targetDir: string,
  pluginLogger: PluginMetricsLogger = noopPluginMetricsLogger,
  extraGitConfig?: ExtraGitConfig,
  materialize: MaterializeSpec = "all",
  sparsePluginClones = false,
): Promise<void> {
  const startedAt = performance.now();
  const refIsCommit = COMMIT_REF_PATTERN.test(ref);
  const refIsHead = ref.toUpperCase() === "HEAD";
  const gitConfig = { ...extraGitConfig, "safe.directory": targetDir };
  const timeouts = cloneTimeouts(sparsePluginClones);
  const { sparse, sparseDirs } = await resolveSparseClonePlan(materialize, sparsePluginClones);
  const sparseArgs = sparseCloneArguments(sparse);
  const sparseFilterArguments = sparse ? ["--filter=blob:none"] : [];
  const batchModeForSparse = sparse ? true : undefined;
  const narrowToSparseDirs = async (timeoutMs: number | undefined): Promise<void> => {
    if (sparse) await setSparseCheckoutDirs(targetDir, sparseDirs, { extraGitConfig: gitConfig, timeoutMs, sshBatchMode: true });
  };
  const attemptClone = async (cloneUrl: string, batchMode: boolean | undefined): Promise<string> => {
    if (refIsHead) return await cloneAtHead(cloneUrl, targetDir, gitConfig, timeouts, sparseArgs, batchMode, narrowToSparseDirs);
    if (refIsCommit) return await cloneAtCommit(cloneUrl, ref, targetDir, gitConfig, timeouts, sparseFilterArguments, batchMode, narrowToSparseDirs);
    return await cloneAtRef(cloneUrl, ref, targetDir, gitConfig, timeouts, sparseArgs, batchMode, narrowToSparseDirs);
  };
  const sshUrl = isSshUrl(gitUrl) ? null : toScmSshUrl(gitUrl);
  let cloneStderr: string;
  if (sshUrl === null) {
    cloneStderr = await attemptClone(gitUrl, batchModeForSparse);
  } else {
    try {
      cloneStderr = await attemptClone(sshUrl, true);
    } catch (error) {
      if (sparsePluginClones && isKilledSubprocessError(error)) throw error;
      await rm(targetDir, { recursive: true, force: true });
      await mkdir(targetDir, { recursive: true });
      cloneStderr = await attemptClone(gitUrl, batchModeForSparse);
    }
  }
  if (sparse && serverIgnoredFilter(cloneStderr)) {
    pluginLogger.log("warn", `shallowClone: server ignored --filter=blob:none for ${gitUrl}; sparse clone downloaded a full pack`);
    pluginLogger.increment("backend_marketplace_client.shallow_clone.filter_ignored_by_server", 1);
  }
  const elapsed = (performance.now() - startedAt).toFixed(1);
  trace("shallowClone %s@%s completed in %sms", gitUrl, ref, elapsed);
  pluginLogger.log("info", `shallowClone ${gitUrl}@${ref} completed in ${elapsed}ms (${sparse ? "sparse" : "full"})`);
}

// ---------------------------------------------------------------------------------------------
// Release assets: naming, downloading, and unpacking
// ---------------------------------------------------------------------------------------------

/** Where a release lives: the API base that serves it and the host its download must come back from. */
interface ReleaseRepoAddress {
  readonly apiBase: string;
  readonly ownerRepo: string;
  readonly host: string;
}

/** Read "host/owner/repo" as a self-hosted release, or "owner/repo" as a release on the public forge. */
function releaseRepoAddress(repo: string): ReleaseRepoAddress {
  const segments = repo.split("/");
  if (segments.length === 3) return { apiBase: `https://${segments[0]}/api/v3`, ownerRepo: `${segments[1]}/${segments[2]}`, host: segments[0]! };
  if (segments.length === 2) return { apiBase: "https://api.github.com", ownerRepo: repo, host: "github.com" };
  throw new Error(`Invalid release repo format: ${repo}`);
}

/** Whether the host a release asset is served from is the release's own host or a trusted asset host. */
function isAllowedReleaseDownloadHost(downloadHost: string, repoHost: string): boolean {
  if (downloadHost === repoHost) return true;
  if (downloadHost.endsWith(".githubusercontent.com")) return true;
  return repoHost === "github.com" ? downloadHost === "github.com" : downloadHost.endsWith(`.${repoHost}`);
}

/** Download the named release asset, checking its size, its host, its redirects and its digest before answering. */
async function downloadReleaseAsset(options: {
  repo: string;
  asset: string;
  tag?: string | undefined;
  expectedSha256?: string | undefined;
  githubToken?: string | undefined;
}): Promise<Buffer> {
  const address = releaseRepoAddress(options.repo);
  const authHeaders = address.host === "github.com" && options.githubToken !== undefined && options.githubToken.length > 0
    ? { Authorization: `token ${options.githubToken}` }
    : {};
  const releaseEndpoint = options.tag
    ? `${address.apiBase}/repos/${address.ownerRepo}/releases/tags/${encodeURIComponent(options.tag)}`
    : `${address.apiBase}/repos/${address.ownerRepo}/releases/latest`;
  const releaseResponse = await fetch(releaseEndpoint, { headers: { Accept: "application/vnd.github.v3+json", "User-Agent": "SlatePluginInstaller", ...authHeaders } });
  if (!releaseResponse.ok) throw new Error(`Failed to fetch release from ${releaseEndpoint}: ${releaseResponse.status} ${releaseResponse.statusText}`);
  const release = await releaseResponse.json() as { assets: Array<{ name: string; size: number; browser_download_url: string }> };
  const assetInfo = release.assets.find(candidate => candidate.name === options.asset);
  if (!assetInfo) throw new Error(`Release asset "${options.asset}" not found. Available assets: ${release.assets.map(candidate => candidate.name).join(", ")}`);
  if (assetInfo.size > RELEASE_ASSET_LIMIT_BYTES) throw new Error(`Release asset "${options.asset}" exceeds maximum size of ${RELEASE_ASSET_LIMIT_BYTES} bytes (actual: ${assetInfo.size})`);
  const assetUrl = new URL(assetInfo.browser_download_url);
  if (assetUrl.protocol !== "https:" || !isAllowedReleaseDownloadHost(assetUrl.hostname, address.host)) throw new Error(`Refusing to download release asset from untrusted host: ${assetUrl.hostname}`);
  const assetResponse = await fetch(assetInfo.browser_download_url, { headers: { "User-Agent": "SlatePluginInstaller", Accept: "application/octet-stream", ...authHeaders } });
  if (!assetResponse.ok) throw new Error(`Failed to download release asset: ${assetResponse.status} ${assetResponse.statusText}`);
  if (assetResponse.url) {
    const finalUrl = new URL(assetResponse.url);
    if (finalUrl.protocol !== "https:" || !isAllowedReleaseDownloadHost(finalUrl.hostname, address.host)) throw new Error(`Refusing to download release asset: redirected to untrusted host: ${finalUrl.hostname}`);
  }
  const buffer = Buffer.from(await assetResponse.arrayBuffer());
  if (buffer.byteLength > RELEASE_ASSET_LIMIT_BYTES) throw new Error(`Release asset "${options.asset}" actual download size exceeds maximum of ${RELEASE_ASSET_LIMIT_BYTES} bytes (actual: ${buffer.byteLength})`);
  if (options.expectedSha256) {
    const actualSha256 = createHash("sha256").update(buffer).digest("hex");
    if (actualSha256 !== options.expectedSha256) throw new Error(`Release asset "${options.asset}" integrity check failed: expected SHA-256 ${options.expectedSha256}, got ${actualSha256}`);
  }
  return buffer;
}

/** Unpack an archive, refusing one that holds too much, unpacks too far, or expands too quickly. */
async function unpackReleaseArchive(archivePath: string, destination: string, compressedBytes: number): Promise<void> {
  let unpackedBytes = 0;
  let entriesRead = 0;
  await extract({
    file: archivePath,
    cwd: destination,
    onReadEntry: (entry: { readonly size: number }) => {
      entriesRead += 1;
      if (entriesRead > ARCHIVE_ENTRY_LIMIT) throw new Error(`Release archive contains too many files (>${ARCHIVE_ENTRY_LIMIT}).`);
      unpackedBytes += entry.size;
      if (unpackedBytes > UNPACKED_ARCHIVE_LIMIT_BYTES) throw new Error(`Release archive uncompressed size exceeds maximum of ${UNPACKED_ARCHIVE_LIMIT_BYTES} bytes.`);
      if (compressedBytes > 0 && unpackedBytes / compressedBytes > ARCHIVE_RATIO_LIMIT) throw new Error(`Release archive has suspicious compression ratio (>${ARCHIVE_RATIO_LIMIT}x).`);
    },
  } as unknown as Parameters<typeof extract>[0]);
}

/** The directory holding the plugin inside an unpacked release: the archive root, or its single wrapper directory. */
async function unpackedPluginDir(archiveRoot: string): Promise<string> {
  const topEntries = await readdir(archiveRoot, { withFileTypes: true });
  const directories = topEntries.filter(entry => entry.isDirectory());
  const files = topEntries.filter(entry => entry.isFile());
  if (directories.length !== 1 || files.length !== 0) return archiveRoot;
  const wrapperDir = join(archiveRoot, directories[0]!.name);
  return containsPluginRootDir(await readdir(wrapperDir)) ? wrapperDir : archiveRoot;
}

/** Copy every entry of a directory into another, in parallel, keeping symlinks as they were. */
async function copyDirectoryEntries(sourceDir: string, targetDir: string): Promise<void> {
  const names = await readdir(sourceDir);
  await Promise.all(names.map(name => cp(join(sourceDir, name), join(targetDir, name), { recursive: true, verbatimSymlinks: true })));
}

/** Download a release's asset, unpack it into a staging directory and copy the plugin out of it into place. */
async function downloadReleaseToDir(
  repo: string,
  asset: string,
  tag: string | undefined,
  targetDir: string,
  expectedSha256?: string,
  githubToken?: string,
): Promise<void> {
  const archive = await downloadReleaseAsset({ repo, asset, tag, expectedSha256, githubToken });
  const compressedBytes = archive.byteLength;
  await mkdir(targetDir, { recursive: true });
  const stagingDir = await mkdtemp(join(tmpdir(), "release-asset-"));
  const archivePath = join(stagingDir, "asset.tar.gz");
  const archiveRoot = join(stagingDir, "extracted");
  try {
    await writeFile(archivePath, archive);
    await mkdir(archiveRoot, { recursive: true });
    await unpackReleaseArchive(archivePath, archiveRoot, compressedBytes);
    const pluginDir = await unpackedPluginDir(archiveRoot);
    await copyDirectoryEntries(pluginDir, targetDir);
  } finally {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------------------------
// The entries a listing answers with
// ---------------------------------------------------------------------------------------------

/** A marketplace as an entry names it: enough to find its clone again, plus the commit it was read at. */
export interface MarketplaceDescriptor {
  name: string;
  id: string;
  gitUrl?: string;
  gitRef?: string;
}

/** One plugin a listing answers with, in the shape an install takes. */
export interface BackendPluginEntry {
  name: string;
  pluginId: string;
  version: string;
  downloadUrl: string;
  pluginDbId?: string | undefined;
  marketplaceDbId?: string | undefined;
  configuredVariables?: unknown;
  isTeamRequired?: boolean | undefined;
  marketplace?: MarketplaceDescriptor | undefined;
  inlineContentJson?: string | undefined;
  gitPath?: string | undefined;
  isOriginBacked?: true | undefined;
}

/** One plugin a listing could not answer with, and the failure that explains it. */
export interface BackendPluginListFailure {
  pluginName: string;
  pluginId: string;
  errorMessage: string;
  errorType: "timeout" | "clone";
  pluginDbId?: string | undefined;
  marketplaceName?: string | undefined;
}

/** The fields every entry carries: what the backend called the plugin, and the user's configuration of it. */
function listedPluginIdentity(
  effective: EffectivePlugin,
  definition: EffectivePluginDefinition,
  name: string,
): { name: string; pluginId: string; pluginDbId: string | undefined; configuredVariables: unknown; isTeamRequired: boolean | undefined } {
  return {
    pluginId: name,
    pluginDbId: definition.id !== undefined ? String(definition.id) : undefined,
    configuredVariables: effective.configuredVariables,
    isTeamRequired: effective.isTeamRequired,
    name,
  };
}

/** The marketplace descriptor of an inline plugin: it has a name, so its clone is never looked up. */
function inlineMarketplaceDescriptor(
  definition: EffectiveMarketplace | null | undefined,
  name: string,
): MarketplaceDescriptor | undefined {
  if (!definition?.name) return undefined;
  return { id: definition.id !== undefined ? `${definition.name}-${definition.id}` : `${definition.name}-inline`, name: definition.name };
}

/** The marketplace descriptor of a listed plugin, carrying the clone and commit its cache was resolved to. */
function marketplaceDescriptorFor(
  definition: EffectiveMarketplace | null | undefined,
  name: string,
  cloneGitUrl: string | undefined,
  cloneGitRef: string,
): MarketplaceDescriptor | undefined {
  if (!definition?.name) return undefined;
  const id = definition.id !== undefined
    ? `${definition.name}-${definition.id}`
    : `${definition.name}-${encodeURIComponent(definition.gitUrl ?? "project")}`;
  return cloneGitUrl
    ? { id, name: definition.name, gitUrl: cloneGitUrl, gitRef: cloneGitRef }
    : { id, name: definition.name };
}

// ---------------------------------------------------------------------------------------------
// Turning an entry into a directory on disk
// ---------------------------------------------------------------------------------------------

/** Everything an install may be told beyond the entry itself. */
interface CloneOptions {
  expectedReleaseAssetSha256?: string | undefined;
  githubToken?: string | undefined;
  sparsePluginClones?: boolean | undefined;
}

/** Copy a release-installed plugin into place, either directly or from the subdirectory the entry names. */
async function installReleaseEntry(
  entry: BackendPluginEntry,
  releaseSource: { repo: string; asset: string; tag?: string | undefined },
  targetDir: string,
  options: CloneOptions | undefined,
): Promise<void> {
  if (!entry.gitPath) {
    await downloadReleaseToDir(releaseSource.repo, releaseSource.asset, releaseSource.tag, targetDir, options?.expectedReleaseAssetSha256, options?.githubToken);
    return;
  }
  const stagingDir = await mkdtemp(join(tmpdir(), "release-plugin-"));
  try {
    await downloadReleaseToDir(releaseSource.repo, releaseSource.asset, releaseSource.tag, stagingDir, options?.expectedReleaseAssetSha256, options?.githubToken);
    const pluginDir = validateAndResolveSubpath(stagingDir, entry.gitPath);
    await mkdir(targetDir, { recursive: true });
    await cp(pluginDir, targetDir, { recursive: true, verbatimSymlinks: true });
  } finally {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** The plugin's directory inside a fresh clone: the path the entry names, or the one the marketplace manifest gives. */
async function repositoryPluginDir(
  entry: BackendPluginEntry,
  source: { gitUrl: string; ref: string; gitPath?: string | undefined },
  cloneDir: string,
  extraGitConfig: ExtraGitConfig | undefined,
  materializeTimeoutMs: number | undefined,
): Promise<string> {
  if (source.gitPath) return validateAndResolveSubpath(cloneDir, source.gitPath);
  const derived = await derivePluginGitPath(cloneDir, entry.name);
  if (derived.type === "resolved") {
    await materializeSparseDirs(cloneDir, materializeSpecForGitPaths([derived.gitPath]), { extraGitConfig, timeoutMs: materializeTimeoutMs });
    return validateAndResolveSubpath(cloneDir, derived.gitPath);
  }
  if (derived.type === "manifest-unresolved") throw new Error(`Unable to install plugin ${JSON.stringify(entry.name)} without gitPath: ${derived.reason}`);
  await materializeSparseDirs(cloneDir, "all", { extraGitConfig, timeoutMs: materializeTimeoutMs });
  return cloneDir;
}

/** Clone a repository-installed plugin into place through a staging directory. */
async function installRepositoryEntry(
  entry: BackendPluginEntry,
  source: { gitUrl: string; ref: string; gitPath?: string | undefined },
  targetDir: string,
  pluginLogger: PluginMetricsLogger,
  extraGitConfig: ExtraGitConfig | undefined,
  options: CloneOptions | undefined,
): Promise<void> {
  const sparsePluginClones = options?.sparsePluginClones ?? false;
  const materializeTimeoutMs = sparsePluginClones ? REMOTE_GIT_TIMEOUT_MS : undefined;
  const stagingDir = await mkdtemp(join(tmpdir(), "backend-plugin-"));
  try {
    const materialize = source.gitPath ? materializeSpecForGitPaths([source.gitPath]) : [];
    await shallowClone(source.gitUrl, source.ref, stagingDir, pluginLogger, extraGitConfig, materialize, sparsePluginClones);
    const pluginDir = await repositoryPluginDir(entry, source, stagingDir, extraGitConfig, materializeTimeoutMs);
    await mkdir(targetDir, { recursive: true });
    await cp(pluginDir, targetDir, { recursive: true, verbatimSymlinks: true });
  } finally {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Write, download or clone one entry into a target directory, whichever route its download URL names. */
async function clonePluginToDir(
  entry: BackendPluginEntry,
  targetDir: string,
  pluginLogger: PluginMetricsLogger = noopPluginMetricsLogger,
  extraGitConfig?: ExtraGitConfig,
  options?: CloneOptions,
): Promise<void> {
  const releaseSource = decodeReleaseSource(entry.downloadUrl);
  if (releaseSource !== null) {
    await installReleaseEntry(entry, releaseSource, targetDir, options);
    return;
  }
  const repositorySource = decodeRepositorySource(entry.downloadUrl);
  if (repositorySource === null) throw new Error(`Invalid download URL format for plugin ${entry.pluginId}: ${entry.downloadUrl}`);
  await installRepositoryEntry(entry, repositorySource, targetDir, pluginLogger, extraGitConfig, options);
}

// ---------------------------------------------------------------------------------------------
// Resolving the commit a listing names
// ---------------------------------------------------------------------------------------------

/** What a version resolution needs from the client that asked for it. */
interface VersionResolutionContext {
  readonly logger: PluginMetricsLogger;
  readonly sparseClones: boolean;
  readonly gitConfigProvider: ExtraGitConfigProvider;
}

/** A key for one repository-and-ref answer, so a listing asks once however many plugins name it. */
function refCacheKey(repositoryUrl: string, ref: string): string {
  return `${repositoryUrl}\0${ref}`;
}

/** Ask the remote for a ref once, over ssh first when it can be spelled that way, and remember the commit. */
function createVersionResolution(context: VersionResolutionContext): {
  resolveWithSourceFallback: (request: { preferredGitUrl: string; sourceGitUrl: string; gitRef: string; pluginId: string }) => Promise<{ sha: string; gitUrl: string }>;
} {
  const shaByRepositoryAndRef = new Map<string, string>();
  const resolveCommit = async (repositoryUrl: string, ref: string): Promise<string> => {
    const key = refCacheKey(repositoryUrl, ref);
    let sha = shaByRepositoryAndRef.get(key);
    if (!sha) {
      const extraGitConfig = resolveExtraGitConfig(context.gitConfigProvider);
      const timeoutMs = context.sparseClones ? LS_REMOTE_TIMEOUT_MS : undefined;
      const sshUrl = isSshUrl(repositoryUrl) ? null : toScmSshUrl(repositoryUrl);
      const askRemote = async (url: string, batchMode: boolean): Promise<string> => {
        const request: { sshBatchMode?: true; extraGitConfig?: ExtraGitConfig; timeoutMs?: number } = {};
        if (batchMode) request.sshBatchMode = true;
        if (extraGitConfig !== undefined) request.extraGitConfig = extraGitConfig;
        if (timeoutMs !== undefined) request.timeoutMs = timeoutMs;
        const answer = Object.keys(request).length > 0 ? await resolveGitRemoteRef(url, ref, request) : await resolveGitRemoteRef(url, ref);
        return answer.fullSha;
      };
      if (sshUrl === null) {
        sha = await askRemote(repositoryUrl, false);
      } else {
        try {
          sha = await askRemote(sshUrl, true);
        } catch (error) {
          if (context.sparseClones && isKilledSubprocessError(error)) throw error;
          sha = await askRemote(repositoryUrl, false);
        }
      }
      shaByRepositoryAndRef.set(key, sha);
    }
    return sha;
  };
  const resolveWithSourceFallback = async (request: { preferredGitUrl: string; sourceGitUrl: string; gitRef: string; pluginId: string }): Promise<{ sha: string; gitUrl: string }> => {
    if (request.preferredGitUrl === request.sourceGitUrl) {
      return { sha: await resolveCommit(request.sourceGitUrl, request.gitRef), gitUrl: request.sourceGitUrl };
    }
    const preferredKey = refCacheKey(request.preferredGitUrl, request.gitRef);
    const firstOriginAttempt = !shaByRepositoryAndRef.has(preferredKey);
    if (firstOriginAttempt) context.logger.increment("marketplace.origin_distribution.fetch", 1);
    try {
      const sha = await resolveCommit(request.preferredGitUrl, request.gitRef);
      if (firstOriginAttempt) {
        try {
          context.logger.log("info", `Resolved plugin ${request.pluginId} from Origin distribution mirror ${request.preferredGitUrl}@${request.gitRef}`, { pluginId: request.pluginId, preferredGitUrl: request.preferredGitUrl, gitRef: request.gitRef });
        } catch {}
      }
      return { sha, gitUrl: request.preferredGitUrl };
    } catch (error) {
      if (firstOriginAttempt) context.logger.increment("marketplace.origin_distribution.fetch.error", 1);
      context.logger.captureException(error, { error_type: "distribution_url_fallback" });
      context.logger.log("warn", `Distribution mirror ${request.preferredGitUrl}@${request.gitRef} unavailable (not synced yet or unreachable); falling back to source ${request.sourceGitUrl}`, { ...request, error: String(error) });
    }
    return { sha: await resolveCommit(request.sourceGitUrl, request.gitRef), gitUrl: request.sourceGitUrl };
  };
  return { resolveWithSourceFallback };
}

// ---------------------------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------------------------

/** Everything a client may be built with, in one object, besides the repository-root shorthand. */
export interface BackendMarketplaceClientOptions {
  marketplaceCacheRoot?: string | undefined;
  pluginLogger?: PluginMetricsLogger | undefined;
  marketplaceCacheOptions?: MarketplaceCacheOptions | undefined;
  listOptions?: {
    allowedMarketplaceNames?: readonly string[] | undefined;
    enableInlinePlugins?: boolean | undefined;
  } | undefined;
  extraGitConfig?: ExtraGitConfigProvider;
  githubToken?: string | undefined;
  sparsePluginClones?: boolean | undefined;
}

/** The backend's marketplaces: list the plugins a user has, and install one of them into a directory. */
export class BackendMarketplaceClient {
  private readonly logger: PluginMetricsLogger;
  private readonly gitConfigProvider: ExtraGitConfigProvider;
  private readonly token: string | undefined;
  private readonly sparseClones: boolean;
  private readonly cache: MarketplaceCacheManager | undefined;
  private readonly allowedMarketplaces: Set<string> | undefined;
  private readonly inlinePluginsEnabled: boolean;

  constructor(
    private readonly getEffectivePlugins: () => Promise<EffectivePluginsResponse>,
    optionsOrMarketplaceCacheRoot?: BackendMarketplaceClientOptions | string,
    pluginLogger?: PluginMetricsLogger,
    marketplaceCacheOptions?: MarketplaceCacheOptions,
    listOptions?: BackendMarketplaceClientOptions["listOptions"],
  ) {
    const options: BackendMarketplaceClientOptions = typeof optionsOrMarketplaceCacheRoot === "string" || optionsOrMarketplaceCacheRoot === undefined
      ? { marketplaceCacheRoot: optionsOrMarketplaceCacheRoot, pluginLogger, marketplaceCacheOptions, listOptions }
      : optionsOrMarketplaceCacheRoot;
    const sharedCacheOptions = options.marketplaceCacheOptions ?? marketplaceCacheOptions;
    this.logger = options.pluginLogger ?? pluginLogger ?? noopPluginMetricsLogger;
    this.gitConfigProvider = options.extraGitConfig;
    this.token = options.githubToken;
    this.sparseClones = options.sparsePluginClones ?? false;
    this.cache = options.marketplaceCacheRoot
      ? new MarketplaceCacheManager(options.marketplaceCacheRoot, {
          ...sharedCacheOptions,
          extraGitConfig: sharedCacheOptions?.extraGitConfig ?? options.extraGitConfig,
          sparsePluginClones: this.sparseClones,
        })
      : undefined;
    const resolvedListOptions = options.listOptions ?? listOptions;
    this.allowedMarketplaces = resolvedListOptions?.allowedMarketplaceNames ? new Set(resolvedListOptions.allowedMarketplaceNames) : undefined;
    this.inlinePluginsEnabled = resolvedListOptions?.enableInlinePlugins ?? false;
  }

  /** Whether a plugin from this marketplace may be listed: only when the listing names no allow-list or names it. */
  private allowsMarketplace(marketplace: EffectiveMarketplace | null | undefined): boolean {
    return this.allowedMarketplaces === undefined || marketplace?.name !== undefined && this.allowedMarketplaces.has(marketplace.name);
  }

  /** The plugins the backend says the user has, each resolved to what an install would fetch. */
  async listEnabledPlugins(_userId?: string, _teamId?: string): Promise<{ plugins: BackendPluginEntry[]; listFailures: BackendPluginListFailure[] }> {
    const response = await this.getEffectivePlugins();
    const rows = response.plugins ?? [];
    const marketplaces = response.marketplaces ?? [];
    const plugins: BackendPluginEntry[] = [];
    const listFailures: BackendPluginListFailure[] = [];
    const versionResolution = createVersionResolution({ logger: this.logger, sparseClones: this.sparseClones, gitConfigProvider: this.gitConfigProvider });

    for (const effective of rows) {
      const definition = effective.plugin;
      if (!effective.isEnabled || !definition?.name) continue;
      const marketplaceDefinition = marketplaceForPlugin(definition, marketplaces);
      if (!this.allowsMarketplace(marketplaceDefinition)) {
        this.logger.log("info", `Skipping plugin ${definition.name} because marketplace ${marketplaceDefinition?.name ?? "<none>"} is not allowed`, { pluginId: definition.name, marketplaceName: marketplaceDefinition?.name, allowedMarketplaceNames: this.allowedMarketplaces !== undefined ? Array.from(this.allowedMarketplaces) : undefined });
        continue;
      }
      const fallbackId = definition.id !== undefined ? String(definition.id) : definition.name ?? "";
      const name = installNameFor(definition.name, fallbackId);

      if (!definition.gitUrl) {
        if (!this.inlinePluginsEnabled) {
          this.logger.log("info", `Skipping plugin ${name} without gitUrl (enableInlinePlugins=false)`, { pluginId: name });
          continue;
        }
        if (!effective.inlineContentJson) {
          this.logger.log("info", `Skipping DB-inline plugin ${name}: no inline content provided`, { pluginId: name });
          continue;
        }
        const version = createHash("sha256").update(`${definition.id ?? "0"}:${definition.updatedAt ?? "0"}`).digest("hex").slice(0, 40);
        const marketplace = inlineMarketplaceDescriptor(marketplaceDefinition, name);
        this.logger.log("info", `BackendMarketplaceClient: Adding DB-inline plugin: ${name}`, { pluginId: name, marketplaceId: marketplace?.id ?? "unknown", version });
        plugins.push({
          ...listedPluginIdentity(effective, definition, name),
          version,
          downloadUrl: `inline://${definition.id ?? name}`,
          marketplaceDbId: marketplaceDefinition?.id !== undefined ? String(marketplaceDefinition.id) : undefined,
          marketplace,
          inlineContentJson: effective.inlineContentJson,
        });
        continue;
      }

      const gitUrl = definition.gitUrl;
      const preferredInstallGitUrl = installGitUrl(gitUrl, marketplaceDefinition);
      const ref = pluginRef(effective, marketplaces);
      const releaseSource = getReleasePluginSource(definition, ref);
      const marketplaceRef = marketplaceDefinition?.gitRef ?? ref;
      let version: string;
      let installRepositoryUrl = preferredInstallGitUrl;
      try {
        if (releaseSource !== undefined) {
          version = `release/${releaseSource.releaseTag}`;
        } else {
          const resolved = await versionResolution.resolveWithSourceFallback({ preferredGitUrl: preferredInstallGitUrl, sourceGitUrl: gitUrl, gitRef: ref, pluginId: name });
          version = resolved.sha;
          installRepositoryUrl = resolved.gitUrl;
        }
      } catch (error) {
        this.logger.captureException(error, { error_type: "resolve_version_sha" });
        this.logger.log("error", `Failed to resolve version for plugin ${name}@${ref}, skipping plugin`, { pluginId: name, ref, error: String(error) });
        const errorMessage = error instanceof Error ? error.message : String(error);
        listFailures.push({
          pluginName: name,
          pluginId: name,
          pluginDbId: definition.id !== undefined ? String(definition.id) : undefined,
          marketplaceName: marketplaceDefinition?.name,
          errorMessage,
          errorType: /timed?\s*out/i.test(errorMessage) ? "timeout" : "clone",
        });
        continue;
      }
      const downloadUrl = releaseSource !== undefined
        ? encodeReleaseSource({ repo: releaseSource.releaseRepo, asset: releaseSource.releaseAsset, tag: releaseSource.releaseTag })
        : encodeRepositorySource(installRepositoryUrl, ref, definition.gitPath ?? undefined);

      const cloneRepositoryUrl = marketplaceCloneGitUrl(marketplaceDefinition);
      let marketplaceInstallUrl = cloneRepositoryUrl;
      let marketplaceCommit = marketplaceRef;
      if (marketplaceDefinition?.gitUrl && cloneRepositoryUrl) {
        const marketplaceUsesPluginRepository = sameRepository(gitUrl, marketplaceDefinition.gitUrl);
        const preferredCacheUrl = marketplaceUsesPluginRepository ? installRepositoryUrl : cloneRepositoryUrl;
        const sourceCacheUrl = marketplaceUsesPluginRepository ? gitUrl : marketplaceDefinition.gitUrl;
        const cacheRef = marketplaceUsesPluginRepository ? ref : marketplaceRef;
        try {
          const resolved = await versionResolution.resolveWithSourceFallback({ preferredGitUrl: preferredCacheUrl, sourceGitUrl: sourceCacheUrl, gitRef: cacheRef, pluginId: name });
          marketplaceCommit = resolved.sha;
          marketplaceInstallUrl = resolved.gitUrl;
        } catch (error) {
          this.logger.captureException(error, { error_type: "resolve_marketplace_cache_ref" });
          this.logger.log("warn", `Failed to resolve marketplace cache ref for plugin ${name} from ${preferredCacheUrl}@${cacheRef}, falling back to raw ref`, { pluginId: name, cacheRepoUrl: preferredCacheUrl, cacheRef, error: String(error) });
          marketplaceInstallUrl = sourceCacheUrl;
        }
      }
      const marketplace = marketplaceDescriptorFor(marketplaceDefinition, name, marketplaceInstallUrl, marketplaceCommit);
      this.logger.log("info", `BackendMarketplaceClient: Adding enabled plugin: ${name} from ${marketplaceCommit} at ${definition.gitPath}`, { pluginId: name, marketplaceId: marketplace?.id ?? "unknown", gitPath: definition.gitPath ?? undefined, gitRef: marketplaceCommit });
      plugins.push({
        ...listedPluginIdentity(effective, definition, name),
        version,
        downloadUrl,
        marketplaceDbId: marketplaceDefinition?.id !== undefined ? String(marketplaceDefinition.id) : undefined,
        marketplace,
        gitPath: definition.gitPath ?? undefined,
        isOriginBacked: releaseSource === undefined && installRepositoryUrl !== gitUrl ? true : undefined,
      });
    }
    return { plugins, listFailures };
  }

  /** Whether an entry installs from a marketplace cache by fetching exactly what a direct install would fetch. */
  private repeatsTheSameFetch(entry: BackendPluginEntry): boolean {
    const marketplace = entry.marketplace;
    if (!marketplace?.gitUrl || !marketplace.gitRef) return false;
    const direct = decodeRepositorySource(entry.downloadUrl);
    return direct !== null && sameRepository(direct.gitUrl, marketplace.gitUrl) && (direct.ref === marketplace.gitRef || entry.version === marketplace.gitRef);
  }

  /** Install one listed entry into a directory: inline content, a marketplace cache, or the entry's own source. */
  async installPlugin(entry: BackendPluginEntry, targetDir: string): Promise<void> {
    if (entry.inlineContentJson) {
      await synthesizeInlinePluginDir({ targetDir, inlineContentJson: entry.inlineContentJson, pluginName: entry.name });
      return;
    }
    if (decodeReleaseSource(entry.downloadUrl) === null) {
      try {
        if (await this.installFromMarketplaceCache(entry, targetDir)) {
          this.reportOriginDistributionLoad(entry);
          return;
        }
      } catch (error) {
        this.logger.captureException(error, { error_type: "install_plugin_from_marketplace_cache" });
        if (this.sparseClones && this.repeatsTheSameFetch(entry) && isKilledSubprocessError(error)) {
          this.logger.log("warn", `Failed to install plugin ${entry.name} from marketplace cache; skipping direct install fallback because it would repeat the identical fetch`, { pluginId: entry.pluginId, version: entry.version, error: String(error) });
          throw error;
        }
        this.logger.log("warn", `Failed to install plugin ${entry.name} from marketplace cache, falling back to direct install`, { pluginId: entry.pluginId, version: entry.version, error: String(error) });
      }
    }
    await clonePluginToDir(entry, targetDir, this.logger, resolveExtraGitConfig(this.gitConfigProvider), { githubToken: this.token, sparsePluginClones: this.sparseClones });
    this.reportOriginDistributionLoad(entry);
  }

  /** Say that an origin-backed plugin was loaded from the distribution mirror, when the logger can hear it. */
  private reportOriginDistributionLoad(entry: BackendPluginEntry): void {
    if (!entry.isOriginBacked) return;
    try {
      this.logger.increment("marketplace.origin_distribution.load", 1);
      this.logger.log("info", `Loaded plugin ${entry.pluginId} from Origin distribution (fetch complete)`, { pluginId: entry.pluginId });
    } catch {}
  }

  /** Fetch each marketplace's clone once for all the plugin directories a listing asked for. */
  async prewarmMarketplaceClones(entries: readonly BackendPluginEntry[]): Promise<void> {
    if (!this.cache) return;
    const groups = new Map<string, { marketplaceId: string; gitUrl: string; gitRef: string; gitPaths: string[] }>();
    for (const entry of entries) {
      const marketplace = entry.marketplace;
      if (!marketplace?.gitUrl) continue;
      const gitRef = marketplace.gitRef ?? "main";
      const key = `${marketplace.id}\0${marketplace.gitUrl}\0${gitRef}`;
      let group = groups.get(key);
      if (group === undefined) {
        group = { marketplaceId: marketplace.id, gitUrl: marketplace.gitUrl, gitRef, gitPaths: [] };
        groups.set(key, group);
      }
      if (entry.gitPath) group.gitPaths.push(entry.gitPath);
    }
    for (const group of groups.values()) {
      const materialize = materializeSpecForGitPaths(group.gitPaths);
      const startedAt = performance.now();
      try {
        await this.cache.ensureCloned(group.marketplaceId, group.gitUrl, group.gitRef, this.logger, { materialize });
        this.logger.log("info", `Prewarmed marketplace clone ${group.gitUrl}@${group.gitRef} for ${group.gitPaths.length} plugin directories`, { ...group, requestedDirs: group.gitPaths.length, materialize: materialize === "all" ? "all" : materialize.length });
        this.logger.increment("marketplace_cache_manager.prewarm.success", 1, { materialize: materialize === "all" ? "all" : "dirs" });
      } catch (error) {
        this.logger.captureException(error, { error_type: "prewarm_marketplace_clone" });
        this.logger.log("warn", `Failed to prewarm marketplace clone ${group.gitUrl}@${group.gitRef}; falling back to per-plugin materialization`, { ...group, error: String(error) });
        this.logger.increment("marketplace_cache_manager.prewarm.error", 1);
      }
      this.logger.distribution("marketplace_cache_manager.prewarm.duration", performance.now() - startedAt);
    }
  }

  /** Install an entry from the marketplace cache it names, answering whether the cache could serve it. */
  private async installFromMarketplaceCache(entry: BackendPluginEntry, targetDir: string): Promise<boolean> {
    const cache = this.cache;
    const marketplace = entry.marketplace;
    if (!cache || !marketplace?.gitUrl) {
      this.logger.log("info", "No marketplace cache or marketplace metadata, skipping cache check", { pluginId: entry.pluginId, name: entry.name, version: entry.version, marketplaceId: entry.marketplace?.id });
      return false;
    }
    const cloneDir = await cache.ensureCloned(marketplace.id, marketplace.gitUrl, marketplace.gitRef ?? "main", this.logger, { materialize: entry.gitPath ? materializeSpecForGitPaths([entry.gitPath]) : [] });
    const gitPath = entry.gitPath ?? await cache.resolvePluginPath(cloneDir, entry.name);
    if (!gitPath) {
      this.logger.log("info", "No git path found for plugin, skipping cache check", { pluginId: entry.pluginId, name: entry.name, version: entry.version, marketplaceId: entry.marketplace?.id });
      return false;
    }
    if (entry.gitPath === undefined) await cache.ensureMaterialized(cloneDir, materializeSpecForGitPaths([gitPath]), this.logger);
    await cache.copyPluginToDir(cache.getPluginDir(cloneDir, gitPath), targetDir);
    return true;
  }

  /** Read the plugins a marketplace's clone carries, cloning it first when the client has a cache. */
  async discoverMarketplacePlugins(marketplaceId: string, gitUrl: string, gitRef: string) {
    const cache = this.cache;
    if (!cache) throw new Error("discoverMarketplacePlugins requires a MarketplaceCacheManager (marketplaceCacheRoot)");
    const cloneDir = await cache.ensureCloned(marketplaceId, gitUrl, gitRef, this.logger, { materialize: [] });
    return cache.discoverPlugins(cloneDir);
  }
}

/** A client for the backend's marketplaces, built with the shorter positional form or the options object. */
export function createBackendMarketplaceClient(
  getEffectiveUserPlugins: () => Promise<EffectivePluginsResponse>,
  marketplaceCacheRootOrOptions?: string | BackendMarketplaceClientOptions,
  pluginLogger?: PluginMetricsLogger,
  marketplaceCacheOptions?: MarketplaceCacheOptions,
  listOptions?: BackendMarketplaceClientOptions["listOptions"],
): BackendMarketplaceClient {
  return new BackendMarketplaceClient(getEffectiveUserPlugins, marketplaceCacheRootOrOptions, pluginLogger, marketplaceCacheOptions, listOptions);
}
