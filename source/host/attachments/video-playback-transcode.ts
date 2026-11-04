import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";

import { VIDEO_TOOL_TIMEOUT_MS } from "./video-playback-contracts.ts";
import { videoPlaybackCacheDir } from "./video-playback-cache-path.ts";

const TRANSCODE_LIMIT = 2;
let transcodesInFlight = 0;
const releasedSlots: Array<() => void> = [];

async function useTranscodeSlot<T>(operation: () => Promise<T>): Promise<T> {
  if (transcodesInFlight >= TRANSCODE_LIMIT) {
    await new Promise<void>((resume) => releasedSlots.push(resume));
  }
  transcodesInFlight += 1;
  try {
    return await operation();
  } finally {
    transcodesInFlight -= 1;
    releasedSlots.shift()?.();
  }
}

export function runVideoTool(command: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, [...args], {
      encoding: "utf8",
      maxBuffer: 64 * 1024,
      timeout: VIDEO_TOOL_TIMEOUT_MS,
    }, (error, stdout) => error === null ? resolve(stdout) : reject(error));
  });
}

async function hasCompleteRendition(path: string): Promise<boolean> {
  try {
    const info = await fs.stat(path);
    return info.isFile() && info.size > 0;
  } catch {
    return false;
  }
}

async function codecOf(sourcePath: string): Promise<string | null> {
  try {
    const result = await runVideoTool("ffprobe", [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=codec_name",
      "-of", "default=noprint_wrappers=1:nokey=1",
      "-protocol_whitelist", "file",
      sourcePath,
    ]);
    return result.trim().toLowerCase();
  } catch {
    return null;
  }
}

async function encodeForPlayback(sourcePath: string, renditionPath: string): Promise<string | null> {
  if (await hasCompleteRendition(renditionPath)) return renditionPath;

  await fs.mkdir(videoPlaybackCacheDir, { recursive: true });
  const temporaryPath = `${renditionPath}.${randomUUID()}.tmp.mp4`;
  try {
    await runVideoTool("ffmpeg", [
      "-v", "error",
      "-nostdin",
      "-y",
      "-protocol_whitelist", "file",
      "-i", sourcePath,
      "-map", "0:v:0",
      "-map", "0:a:0?",
      "-c:v", "libx264",
      "-threads", "2",
      "-preset", "veryfast",
      "-crf", "23",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-b:a", "128k",
      "-movflags", "+faststart",
      temporaryPath,
    ]);
    const info = await fs.stat(temporaryPath);
    if (!info.isFile() || info.size === 0) return null;
    await fs.rename(temporaryPath, renditionPath);
    return renditionPath;
  } catch {
    return null;
  } finally {
    await Promise.allSettled([fs.rm(temporaryPath, { force: true })]);
  }
}

export async function createVideoPlaybackSource(sourcePath: string, renditionPath: string): Promise<string | null> {
  const codec = await codecOf(sourcePath);
  if (codec === null) return null;
  if (codec !== "hevc") return sourcePath;
  if (await hasCompleteRendition(renditionPath)) return renditionPath;
  return useTranscodeSlot(() => encodeForPlayback(sourcePath, renditionPath));
}
