/** User-scoped config location and the size budget for local socket paths. */

import { homedir } from "node:os";
import { join } from "node:path";

const CONFIG_DIRECTORY = "slate";
const USER_CONFIG_DIRECTORY = ".slate";
const SOCKET_FILE_NAME = "worker.sock";

export const HASH_LENGTH = 7;
export const MAX_SOCKET_PATH_LENGTH = 104;
export const WINDOWS_SOCK_LENGTH = SOCKET_FILE_NAME.length;
export const MAX_PREFIX_LENGTH_BEFORE_HASH = MAX_SOCKET_PATH_LENGTH - HASH_LENGTH - WINDOWS_SOCK_LENGTH - 2;
export const MAX_FULL_PATH_LENGTH = MAX_SOCKET_PATH_LENGTH - WINDOWS_SOCK_LENGTH - 1;

function nonBlankOverride(value: string | undefined): string | undefined {
  return value !== undefined && value.trim().length > 0 ? value : undefined;
}

export function getConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const selected = nonBlankOverride(env.SLATE_CONFIG_DIR);
  if (selected !== undefined) return selected;

  const xdgDirectory = nonBlankOverride(env.XDG_CONFIG_HOME);
  if (xdgDirectory !== undefined) return join(xdgDirectory, CONFIG_DIRECTORY);
  return join(homedir(), USER_CONFIG_DIRECTORY);
}
