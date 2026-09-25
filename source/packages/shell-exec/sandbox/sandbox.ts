/**
 * Starting a command under a policy, or refusing to start it.
 *
 * This is the one place a command is actually started, and what it does depends on the policy it was given.
 * A policy that asks for a shared build cache is given the cache directories before the command runs, since
 * the point of the cache is that the command uses it. A policy that says the command is not sandboxed runs
 * it directly — that is what the caller asked for, and the function that does it is named for what it is. And
 * a policy that does sandbox the command is only honoured when the machine can enforce it: if the helper is
 * not there, the command is refused with the reason rather than run without the sandbox it asked for.
 *
 * The environment is filtered of the flag that would turn the child into a node process whichever way the
 * command is started, since a shell is not a node process.
 */

import { filterElectronEnv } from "../env-filter.ts"
import { getSandboxCacheEnv } from "./cache-env.ts"
import { SandboxUnsupportedError } from "./errors.ts"
import { getLastSandboxFailureReason, isSandboxHelperSupported, spawnWithSandboxHelper, type SandboxHelperPolicy } from "./helper-support.ts"
import { spawnUnsafe } from "./unsafe-spawn.ts"
import type { SpawnOptions, ChildProcess } from "node:child_process"

export type SandboxExecutionPolicy = SandboxHelperPolicy

export function spawnInSandbox(
  command: string,
  args: readonly string[] = [],
  options: SpawnOptions = {},
  sandboxPolicy: SandboxExecutionPolicy,
): ChildProcess {
  options.env = filterElectronEnv(options.env)
  if (sandboxPolicy.enableSharedBuildCache) {
    // The cache is set under whatever the caller passed, so an explicit cache still wins.
    options = {
      ...options,
      env: {
        ...filterElectronEnv(process.env),
        ...getSandboxCacheEnv(),
        ...options.env,
      },
    }
  }
  if (sandboxPolicy.type !== "insecure_none") {
    if (isSandboxHelperSupported()) {
      return spawnWithSandboxHelper(command, args, options, sandboxPolicy)
    }
    const failureReason = getLastSandboxFailureReason()
    throw new SandboxUnsupportedError(
      `Sandbox policy '${sandboxPolicy.type}' is not supported on this system. Ensure the sandbox helper binary is available, or use 'insecure_none'. Reason: ${failureReason || "unknown"}`,
      failureReason ?? undefined,
    )
  }
  return spawnUnsafe(command, args, options)
}
