export const SLATE_WALLPAPER_COMMAND = "/usr/local/bin/slate-wallpaper";
export const SLATE_WALLPAPER_TONE_SCRIPT = "/usr/local/bin/slate-wallpaper-tone.mjs";
export const X_SOCKET_DIR = "/tmp/.X11-unix";
export const COMMAND_TIMEOUT_MS = 10_000;

export interface LiveWallpaperDisplay {
  readonly display: string;
  readonly uid: number;
  readonly gid: number;
}

export interface WallpaperCommandRunner {
  (file: string, args: readonly string[], options: { readonly timeout: number; readonly uid?: number; readonly gid?: number }): Promise<{ readonly stdout: string }>;
}

export interface BoxWallpaperCommandOptions {
  readonly settingsPath: string;
  readonly log: (message: string) => void;
  readonly nodePath?: string;
  readonly toneScriptPath?: string;
  readonly wallpaperCommandPath?: string;
  readonly xSocketDir?: string;
  readonly runCommand?: WallpaperCommandRunner;
  readonly readDisplays?: (directory: string) => Promise<LiveWallpaperDisplay[]>;
  readonly exists?: (path: string) => boolean;
}
