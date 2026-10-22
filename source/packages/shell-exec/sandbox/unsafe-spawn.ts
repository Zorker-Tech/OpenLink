import { spawn } from "node:child_process"
import type { ChildProcess, SpawnOptions } from "node:child_process"

/**
 * The process forwarding branch used only when the caller explicitly asked for no sandbox at all.
 *
 * It is deliberately not exported from the package root and no caller selects it, because running a command
 * without a sandbox is the one thing the rest of this package exists to avoid: it is here so the choice is
 * visible in one place rather than hidden behind a condition somewhere else.
 */

/** The one place this package forwards a command to a child process with no sandbox around it. */
export function spawnUnsafe(executable: string, argumentList: readonly string[] = [], spawnOptions: SpawnOptions = {}): ChildProcess {
  return spawn(executable, argumentList, spawnOptions)
}
