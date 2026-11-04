import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";

import {
  FAILED_RESOLUTION_RETRY_MS,
  MAX_CACHED_RENDITIONS,
  type VideoPlaybackResolution,
} from "./video-playback-contracts.ts";
import { videoPlaybackCacheDir } from "./video-playback-cache-path.ts";
import { createVideoPlaybackSource } from "./video-playback-transcode.ts";

const resolutionsByVersion = new Map<string, VideoPlaybackResolution>();

function versionKey(sourcePath: string, size: number, modifiedAt: number): string {
  return createHash("sha256")
    .update(sourcePath)
    .update("\0")
    .update(String(size))
    .update("\0")
    .update(String(modifiedAt))
    .digest("hex");
}

function deleteWhenUnused(resolution: VideoPlaybackResolution): void {
  if (!resolution.evicted || resolution.activeReaders !== 0) return;
  void resolution.promise.then(async () => {
    await Promise.allSettled([fs.rm(resolution.renditionPath, { force: true })]);
  });
}

function markEvicted(resolution: VideoPlaybackResolution): void {
  resolution.evicted = true;
  deleteWhenUnused(resolution);
}

function refreshPosition(key: string, resolution: VideoPlaybackResolution): void {
  resolutionsByVersion.delete(key);
  resolutionsByVersion.set(key, resolution);
}

function expireOldestEntries(): void {
  while (resolutionsByVersion.size > MAX_CACHED_RENDITIONS) {
    const oldestKey = resolutionsByVersion.keys().next().value;
    if (oldestKey === undefined) return;
    const oldest = resolutionsByVersion.get(oldestKey);
    resolutionsByVersion.delete(oldestKey);
    if (oldest !== undefined) markEvicted(oldest);
  }
}

function cacheHit(key: string): VideoPlaybackResolution | undefined {
  const current = resolutionsByVersion.get(key);
  if (current === undefined) return undefined;

  if (current.retryAfter !== undefined && current.retryAfter <= Date.now()) {
    resolutionsByVersion.delete(key);
    markEvicted(current);
    return undefined;
  }

  refreshPosition(key, current);
  return current;
}

function startResolution(key: string, sourcePath: string): VideoPlaybackResolution {
  const renditionPath = join(videoPlaybackCacheDir, `${key}.${randomUUID()}.mp4`);
  const resolution: VideoPlaybackResolution = {
    renditionPath,
    promise: createVideoPlaybackSource(sourcePath, renditionPath),
    activeReaders: 0,
    evicted: false,
  };
  resolutionsByVersion.set(key, resolution);
  void resolution.promise.then((resolved) => {
    if (resolved === null) resolution.retryAfter = Date.now() + FAILED_RESOLUTION_RETRY_MS;
  });
  expireOldestEntries();
  return resolution;
}

export async function withVideoPlaybackSource<T>(
  sourcePath: string,
  read: (resolvedPath: string) => Promise<T>,
): Promise<T> {
  let fileVersion: string;
  try {
    const info = await fs.stat(sourcePath);
    if (!info.isFile()) return read(sourcePath);
    fileVersion = versionKey(sourcePath, info.size, info.mtimeMs);
  } catch {
    return read(sourcePath);
  }

  const resolution = cacheHit(fileVersion) ?? startResolution(fileVersion, sourcePath);
  resolution.activeReaders += 1;
  try {
    return await read(await resolution.promise ?? sourcePath);
  } finally {
    resolution.activeReaders -= 1;
    deleteWhenUnused(resolution);
  }
}
