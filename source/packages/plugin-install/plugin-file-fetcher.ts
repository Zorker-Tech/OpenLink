import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { PluginFileFetcher } from "./component-discovery.ts";
import { validateAndResolveSubpath } from "./validate-subpath.ts";

const PLUGIN_FILE_LIMIT_BYTES = 10 * 1024 * 1024;

export async function isPluginFileSymlink(filePath: string): Promise<boolean> {
  try {
    return (await lstat(filePath)).isSymbolicLink();
  } catch {
    return false;
  }
}

export async function assertPluginFileWithinLimit(filePath: string): Promise<void> {
  const details = await stat(filePath);
  if (details.size > PLUGIN_FILE_LIMIT_BYTES) {
    throw new Error(`File ${filePath} exceeds maximum size of ${PLUGIN_FILE_LIMIT_BYTES} bytes`);
  }
}

export async function readPluginTextWithoutSymlink(filePath: string): Promise<string> {
  if (await isPluginFileSymlink(filePath)) throw new Error(`Refusing to read symlink: ${filePath}`);
  return readFile(filePath, "utf-8");
}

/** Reads only files whose lexical and resolved paths stay under the installed plugin root. */
export function createLocalPluginFileFetcher(
  basePath: string,
  options?: { readonly symlinkTargetRoot?: string },
): PluginFileFetcher {
  const resolvedPluginRoot = resolve(basePath);
  const symlinkBoundary = resolve(options?.symlinkTargetRoot ?? resolvedPluginRoot);
  const canonicalBoundary = realpath(symlinkBoundary).catch(() => symlinkBoundary);
  const textByPath = new Map<string, string>();

  function resolvePluginPath(fullPath: string): string {
    try {
      return validateAndResolveSubpath(resolvedPluginRoot, resolve(fullPath));
    } catch {
      throw new Error(`Path escapes plugin directory: ${fullPath}`);
    }
  }

  async function resolveCanonicalPluginPath(fullPath: string): Promise<string> {
    const candidatePath = resolvePluginPath(fullPath);
    const actualPath = await realpath(candidatePath);
    try {
      return validateAndResolveSubpath(await canonicalBoundary, actualPath);
    } catch {
      throw new Error(`Path escapes plugin directory via symlink: ${fullPath}`);
    }
  }

  return {
    async listDirectory(dirPath: string, visitedRealDirPaths?: Set<string>) {
      const candidatePath = resolvePluginPath(dirPath ? join(basePath, dirPath) : basePath);
      try {
        const realDirectoryPath = await resolveCanonicalPluginPath(candidatePath);
        if (visitedRealDirPaths?.has(realDirectoryPath)) return [];
        visitedRealDirPaths?.add(realDirectoryPath);

        const directoryEntries = await readdir(realDirectoryPath, { withFileTypes: true });
        const visibleEntries = [];
        for (const entry of directoryEntries) {
          const entryPath = join(candidatePath, entry.name);
          let entryType: "dir" | "file" = entry.isDirectory() ? "dir" : "file";
          if (entry.isSymbolicLink()) {
            try {
              const resolvedTarget = await resolveCanonicalPluginPath(entryPath);
              entryType = (await stat(resolvedTarget)).isDirectory() ? "dir" : "file";
            } catch {
              continue;
            }
          }
          visibleEntries.push({
            name: entry.name,
            type: entryType,
            path: dirPath ? `${dirPath}/${entry.name}` : entry.name,
          });
        }
        return visibleEntries;
      } catch {
        return [];
      }
    },

    async fetchFile(filePath: string) {
      const cachedText = textByPath.get(filePath);
      if (cachedText !== undefined) return { content: cachedText };

      const safePath = resolvePluginPath(join(basePath, filePath));
      const realFilePath = await resolveCanonicalPluginPath(safePath);
      await assertPluginFileWithinLimit(realFilePath);
      const text = await readFile(realFilePath, "utf-8");
      textByPath.set(filePath, text);
      return { content: text };
    },

    async fileExists(filePath: string) {
      try {
        const realFilePath = await resolveCanonicalPluginPath(resolvePluginPath(join(basePath, filePath)));
        return (await stat(realFilePath)).isFile();
      } catch {
        return false;
      }
    },
  };
}
