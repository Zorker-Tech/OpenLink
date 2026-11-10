import { tmpdir } from "node:os";
import { join } from "node:path";

export const videoPlaybackCacheDir = join(tmpdir(), `slate-video-playback-${process.pid}`);
