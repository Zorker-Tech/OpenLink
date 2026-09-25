import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process"

/**
 * The process forwarding branch used only when the caller explicitly asked for no sandbox at all.
 *
 * It is deliberately not exported from the package root and no caller selects it, because running a command
 * without a sandbox is the one thing the rest of this package exists to avoid: it is here so the choice is
 * visible in one place rather than hidden behind a condition somewhere else.
 */
export function spawnUnsafe(command: string, args: readonly string[] = [], options: SpawnOptions = {}): ChildProcess {
  return spawn(command, args, options)
}
