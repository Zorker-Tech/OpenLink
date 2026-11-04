import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import type { BoxWallpaperCommandOptions, WallpaperCommandRunner } from "./wallpaper-command-contracts.ts";
import { COMMAND_TIMEOUT_MS, SLATE_WALLPAPER_COMMAND, SLATE_WALLPAPER_TONE_SCRIPT, X_SOCKET_DIR } from "./wallpaper-command-contracts.ts";
import { asDisplayOwner, readLiveDisplays } from "./wallpaper-display-discovery.ts";
import { parseTonePlan } from "./wallpaper-tone-plan.ts";

function runInstalledCommand(
  file: string,
  args: readonly string[],
  options: { readonly timeout: number; readonly uid?: number; readonly gid?: number },
): Promise<{ readonly stdout: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (error, stdout) => error == null ? resolve({ stdout }) : reject(error));
  });
}

function formatFailure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createBoxWallpaperCommands(options: BoxWallpaperCommandOptions) {
  const node = options.nodePath ?? process.execPath;
  const toneScript = options.toneScriptPath ?? SLATE_WALLPAPER_TONE_SCRIPT;
  const painter = options.wallpaperCommandPath ?? SLATE_WALLPAPER_COMMAND;
  const socketDirectory = options.xSocketDir ?? X_SOCKET_DIR;
  const execute = options.runCommand ?? runInstalledCommand as WallpaperCommandRunner;
  const pathExists = options.exists ?? existsSync;

  return {
    isAvailable: pathExists(toneScript) && pathExists(painter),
    async resolvePlan() {
      let result: { readonly stdout: string } | undefined;
      try {
        result = await execute(node, [toneScript, options.settingsPath], { timeout: COMMAND_TIMEOUT_MS });
      } catch (error) {
        options.log(`wallpaper: tone helper failed (${formatFailure(error)})`);
        return undefined;
      }
      const plan = parseTonePlan(result.stdout);
      if (plan === undefined) options.log("wallpaper: tone helper printed an unusable plan");
      return plan;
    },
    async paint() {
      let displays;
      try {
        displays = await (options.readDisplays ?? readLiveDisplays)(socketDirectory);
      } catch (error) {
        options.log(`wallpaper: reading live displays failed (${formatFailure(error)})`);
        return;
      }
      for (const display of displays) {
        try {
          await execute(painter, ["paint", display.display], {
            timeout: COMMAND_TIMEOUT_MS,
            ...asDisplayOwner(display),
          });
        } catch (error) {
          options.log(`wallpaper: paint of ${display.display} failed (${formatFailure(error)})`);
        }
      }
    },
  };
}
