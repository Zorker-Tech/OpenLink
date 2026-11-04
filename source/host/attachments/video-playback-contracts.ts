export const VIDEO_TOOL_TIMEOUT_MS = 2 * 60 * 1_000;
export const MAX_CACHED_RENDITIONS = 8;
export const FAILED_RESOLUTION_RETRY_MS = 30_000;

export interface VideoPlaybackResolution {
  readonly renditionPath: string;
  readonly promise: Promise<string | null>;
  activeReaders: number;
  evicted: boolean;
  retryAfter?: number;
}
