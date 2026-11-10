/**
 * Where a plugin's files are cached once they have been fetched.
 *
 * A plugin is fetched from a marketplace and unpacked into the platform's own directory, under a path built from the
 * marketplace, the plugin and the version — each of them reduced to something a path may hold, so a name with a slash
 * in it cannot escape the cache. A cached copy is complete only when its sentinel file is there, which is what tells a
 * half-finished unpack from a finished one.
 */
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { extract } from "tar";
import { sanitizeFilename } from "../utils/managed-paths.ts";

export const PLUGINS_CACHE_ROOT = "plugins/cache";
export const PLUGIN_CACHE_SENTINEL = ".cache-complete";

export interface PluginCacheKey {
  readonly marketplaceSlug: string;
  readonly pluginId: string;
  readonly version?: string;
}

/** A marketplace or plugin name becomes one path segment, so no name can escape the cache. */
function safeFolderName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function safeVersionFolder(value: string): string {
  return sanitizeFilename(value);
}

function cachePathIn(
  cacheRoot: string,
  marketplaceSlug: string,
  pluginId: string,
  version?: string,
): string {
  const segments = [cacheRoot, marketplaceSlug, pluginId];
  if (version !== undefined) segments.push(version);
  return join(...segments);
}

export function getPluginInstallCachePath(
  cacheRoot: string,
  input: PluginCacheKey,
): string {
  return cachePathIn(
    cacheRoot,
    safeFolderName(input.marketplaceSlug),
    safeFolderName(input.pluginId),
    input.version !== undefined
      ? safeVersionFolder(input.version)
      : undefined,
  );
}

export class DefaultPluginCacheManager {
  readonly cacheRoot: string;

  constructor(
    userHomeDir?: string,
    settings?: { readonly cacheRoot?: string },
  ) {
    const userHome = userHomeDir ?? process.env.HOME ?? "";
    this.cacheRoot = settings?.cacheRoot
      ?? join(userHome, ".slate", PLUGINS_CACHE_ROOT);
  }

  getCacheDir(input: PluginCacheKey): string {
    return getPluginInstallCachePath(this.cacheRoot, input);
  }

  async isCached(input: PluginCacheKey): Promise<boolean> {
    const cacheDirectory = this.getCacheDir(input);
    try {
      const entryStats = await stat(join(cacheDirectory, PLUGIN_CACHE_SENTINEL));
      return entryStats.isFile();
    } catch {
      return false;
    }
  }

  async extractToCache(
    input: PluginCacheKey & { readonly tarball: Uint8Array },
  ): Promise<string> {
    const cacheDirectory = this.getCacheDir(input);
    await mkdir(cacheDirectory, { recursive: true });
    const tarballStream = Readable.from(input.tarball);
    await pipeline(
      tarballStream,
      createGunzip(),
      extract({ cwd: cacheDirectory, strip: 1 }),
    );
    await this.markCacheComplete(input);
    return cacheDirectory;
  }

  async listCachedVersions(
    input: Omit<PluginCacheKey, "version">,
  ): Promise<string[]> {
    const folderSlug = safeFolderName(input.marketplaceSlug);
    const folderPluginId = safeFolderName(input.pluginId);
    const pluginDirectory = join(this.cacheRoot, folderSlug, folderPluginId);
    try {
      const directoryEntries = await readdir(pluginDirectory, { withFileTypes: true });
      return directoryEntries.filter(dirent => dirent.isDirectory()).map(dirent => dirent.name);
    } catch {
      return [];
    }
  }

  async removeVersion(input: PluginCacheKey): Promise<void> {
    try {
      await rm(this.getCacheDir(input), { recursive: true, force: true });
    } catch {
      // Cache cleanup is best effort in the immutable implementation.
    }
  }

  async removeAllVersions(
    input: Omit<PluginCacheKey, "version">,
  ): Promise<void> {
    await rm(getPluginInstallCachePath(this.cacheRoot, input), {
      recursive: true,
      force: true,
    });
  }

  async pruneOldVersions(
    input: Omit<PluginCacheKey, "version"> & {
      readonly keepVersions: readonly string[];
    },
  ): Promise<void> {
    const storedVersions = await this.listCachedVersions(input);
    const retainedVersions = new Set(
      input.keepVersions.map(version => safeVersionFolder(version)),
    );
    for (const version of storedVersions) {
      if (!retainedVersions.has(version)) {
        await this.removeVersion({ ...input, version });
      }
    }
  }

  async markCacheComplete(input: PluginCacheKey): Promise<void> {
    await writeFile(join(this.getCacheDir(input), PLUGIN_CACHE_SENTINEL), "");
  }
}
