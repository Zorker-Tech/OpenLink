import { constants, copyFileSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { reanchorSlatePath } from "../host-paths.ts";
import { CANONICAL_AVATAR_FILENAME, CONVENTIONAL_AVATAR_EXTENSIONS } from "./agent-avatar-contracts.ts";
import { sniffAvatarMimeType } from "./agent-avatar-format.ts";

const AVATAR_NAME_PATTERN = new RegExp(`^avatar\\.(${CONVENTIONAL_AVATAR_EXTENSIONS.join("|")})$`, "i");

export function isConventionalAvatarFilename(name: string): boolean {
  return AVATAR_NAME_PATTERN.test(name);
}

export function conventionalAvatarRank(name: string): number {
  if (name === CANONICAL_AVATAR_FILENAME) return -1;
  const suffix = extname(name).slice(1).toLowerCase() as typeof CONVENTIONAL_AVATAR_EXTENSIONS[number];
  const rank = CONVENTIONAL_AVATAR_EXTENSIONS.indexOf(suffix);
  return rank < 0 ? CONVENTIONAL_AVATAR_EXTENSIONS.length : rank;
}

export function listConventionalAvatarFilenames(agentDir: string): string[] {
  try {
    return readdirSync(agentDir)
      .filter((name) => isConventionalAvatarFilename(name))
      .sort((left, right) => conventionalAvatarRank(left) - conventionalAvatarRank(right) || left.localeCompare(right));
  } catch {
    return [];
  }
}

function containedBy(parent: string, child: string): boolean {
  const pathFromParent = relative(parent, child);
  return pathFromParent.length > 0
    && pathFromParent !== ".."
    && !pathFromParent.startsWith(`..${sep}`)
    && !isAbsolute(pathFromParent);
}

export function resolveAvatarPathWithinDir(agentDir: string, candidate: string | null | undefined): string | null {
  const requestedPath = candidate?.trim();
  if (!requestedPath) return null;

  const anchoredPath = isAbsolute(requestedPath) ? reanchorSlatePath(requestedPath) : requestedPath;
  const absolutePath = isAbsolute(anchoredPath) ? anchoredPath : resolve(agentDir, anchoredPath);
  if (!containedBy(agentDir, absolutePath)) return null;

  try {
    const realFile = realpathSync(absolutePath);
    return containedBy(realpathSync(agentDir), realFile) ? realFile : null;
  } catch {
    return null;
  }
}

function extensionFromMime(mime: string | null): string | undefined {
  const extensionByMime: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/svg+xml": "svg",
  };
  return mime === null ? undefined : extensionByMime[mime];
}

/** Materialize a legacy profile path under the agent-owned directory when it has an allowed image format. */
export function resolveDerivedAvatarFilename(agentDir: string, legacyFieldValue: string | null): string | null {
  const preferred = listConventionalAvatarFilenames(agentDir)[0];
  if (preferred !== undefined) return preferred;

  const legacySource = resolveAvatarPathWithinDir(agentDir, legacyFieldValue);
  if (legacySource === null) return null;
  try {
    if (!statSync(legacySource).isFile()) return null;
    const sourceExtension = extname(legacySource).slice(1).toLowerCase();
    const extension = CONVENTIONAL_AVATAR_EXTENSIONS.includes(sourceExtension as never)
      ? sourceExtension
      : extensionFromMime(sniffAvatarMimeType(readFileSync(legacySource)));
    if (extension == null) return legacyFieldValue;

    const derivedName = `avatar.${extension}`;
    copyFileSync(legacySource, join(agentDir, derivedName), constants.COPYFILE_EXCL);
    return derivedName;
  } catch {
    return legacyFieldValue;
  }
}
