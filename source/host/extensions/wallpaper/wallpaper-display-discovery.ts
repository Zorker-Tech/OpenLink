import { lstatSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { LiveWallpaperDisplay } from "./wallpaper-command-contracts.ts";

const X_SOCKET_NAME = /^X(\d+)$/;

export async function readLiveDisplays(socketDir: string): Promise<LiveWallpaperDisplay[]> {
  const entries = await readdir(socketDir).catch(() => []);
  const numbers = entries
    .map((entry) => X_SOCKET_NAME.exec(entry)?.[1])
    .filter((number): number is string => number !== undefined)
    .sort((left, right) => Number(left) - Number(right));
  const displays: LiveWallpaperDisplay[] = [];
  for (const number of numbers) {
    const stat = lstatSync(join(socketDir, `X${number}`), { throwIfNoEntry: false });
    if (stat?.isSocket() !== true) continue;
    displays.push({ display: `:${number}`, uid: stat.uid, gid: stat.gid });
  }
  return displays;
}

export function asDisplayOwner(
  owner: Pick<LiveWallpaperDisplay, "uid" | "gid">,
  getuid = process.getuid?.bind(process),
  getgid = process.getgid?.bind(process),
): {} | { readonly uid: number; readonly gid: number } {
  const currentUid = getuid?.();
  if (currentUid !== 0 || (owner.uid === currentUid && owner.gid === getgid?.())) return {};
  return { uid: owner.uid, gid: owner.gid };
}
