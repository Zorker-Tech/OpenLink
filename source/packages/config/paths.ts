/**
 * Where the platform keeps its own configuration on this machine.
 *
 * Configuration is per user rather than per project, so it lives in the user's home directory unless the
 * environment points somewhere else — which is what lets a test, a container or a second profile run with
 * its own settings without touching the real ones. The length constants beside it are for the socket path
 * the platform listens on, which has a hard limit on every platform it runs on and a shorter one on
 * Windows; the hashed form of a long path has to fit inside that limit, so the arithmetic is written down
 * once here rather than at each use.
 */

import { homedir } from "node:os"
import { join } from "node:path"

export const HASH_LENGTH = 7
export const MAX_SOCKET_PATH_LENGTH = 104
export const WINDOWS_SOCK_LENGTH = "worker.sock".length
export const MAX_PREFIX_LENGTH_BEFORE_HASH = MAX_SOCKET_PATH_LENGTH - 1 - HASH_LENGTH - 1 - WINDOWS_SOCK_LENGTH
export const MAX_FULL_PATH_LENGTH = MAX_SOCKET_PATH_LENGTH - WINDOWS_SOCK_LENGTH - 1

export function getConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.SLATE_CONFIG_DIR
  if (override?.trim()) return override
  const xdg = env.XDG_CONFIG_HOME
  if (xdg?.trim()) return join(xdg, "slate")
  return join(homedir(), ".slate")
}
