import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { stat } from "node:fs/promises";
import { AVATAR_MAX_BYTES } from "./agent-avatar-contracts.ts";
import { sniffAvatarMimeType } from "./agent-avatar-format.ts";
import { resolveAvatarPathWithinDir } from "./agent-avatar-paths.ts";

interface AvatarStat {
  readonly path: string;
  readonly modifiedAtMs: number;
  readonly byteCount: number;
}

interface CachedAvatarDataUrl {
  readonly fingerprint: string;
  readonly dataUrl: string;
  readonly version: string;
}

const AVATAR_CACHE_LIMIT = 128;
const avatarDataUrlCache = new Map<string, CachedAvatarDataUrl>();

async function statValidatedAvatar(agentDir: string, candidate: string): Promise<AvatarStat | null> {
  const path = resolveAvatarPathWithinDir(agentDir, candidate);
  if (path === null) return null;
  try {
    const metadata = await stat(path);
    if (!metadata.isFile() || metadata.size === 0 || metadata.size > AVATAR_MAX_BYTES) return null;
    return { path, modifiedAtMs: metadata.mtimeMs, byteCount: metadata.size };
  } catch {
    return null;
  }
}

export async function readValidatedAvatar(agentDir: string, candidate: string): Promise<{ bytes: Buffer; mime: string } | null> {
  const metadata = await statValidatedAvatar(agentDir, candidate);
  if (metadata === null) return null;
  try {
    const bytes = await readFile(metadata.path);
    const mime = sniffAvatarMimeType(bytes);
    return mime === null ? null : { bytes, mime };
  } catch {
    return null;
  }
}

export async function readAvatarBytesWithinDir(agentDir: string, candidate: string): Promise<Buffer | null> {
  const avatar = await readValidatedAvatar(agentDir, candidate);
  return avatar?.bytes ?? null;
}

function cacheKey(agentDir: string, avatarPath: string): string {
  return `${agentDir}\0${avatarPath}`;
}

function cacheFingerprint(metadata: AvatarStat): string {
  return `${metadata.modifiedAtMs}:${metadata.byteCount}`;
}

function bumpCacheEntry(key: string, value: CachedAvatarDataUrl): void {
  avatarDataUrlCache.delete(key);
  avatarDataUrlCache.set(key, value);
  if (avatarDataUrlCache.size <= AVATAR_CACHE_LIMIT) return;
  const leastRecentKey = avatarDataUrlCache.keys().next().value;
  if (leastRecentKey !== undefined && leastRecentKey !== key) avatarDataUrlCache.delete(leastRecentKey);
}

/** Read the validated image as a data URL, reusing a small LRU cache keyed by path and file metadata. */
export async function readAvatarWithinDir(agentDir: string, candidate: string): Promise<{ dataUrl: string; version: string } | null> {
  const metadata = await statValidatedAvatar(agentDir, candidate);
  if (metadata === null) return null;
  const key = cacheKey(agentDir, metadata.path);
  const fingerprint = cacheFingerprint(metadata);
  const cached = avatarDataUrlCache.get(key);
  if (cached?.fingerprint === fingerprint) {
    avatarDataUrlCache.delete(key);
    avatarDataUrlCache.set(key, cached);
    return { dataUrl: cached.dataUrl, version: cached.version };
  }

  try {
    const bytes = await readFile(metadata.path);
    const mime = sniffAvatarMimeType(bytes);
    if (mime === null) return null;
    const value = {
      fingerprint,
      dataUrl: `data:${mime};base64,${bytes.toString("base64")}`,
      version: createHash("sha256").update(bytes).digest("hex").slice(0, 16),
    };
    bumpCacheEntry(key, value);
    return { dataUrl: value.dataUrl, version: value.version };
  } catch {
    return null;
  }
}

export function invalidateAvatarDataUrlCache(agentDir: string): void {
  const prefix = `${agentDir}\0`;
  for (const key of avatarDataUrlCache.keys()) {
    if (key.startsWith(prefix)) avatarDataUrlCache.delete(key);
  }
}
