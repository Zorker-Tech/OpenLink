import type { SpawnOptions } from "node:child_process"

import { scrubSocketEnvVars } from "../env-filter.ts"
import { withConfiguredRipgrepEnv } from "../ripgrep.ts"
import type { HelperShellOptions } from "./helper-protocol-contracts.ts"

/** Merge inherited and explicit variables while stripping session sockets on Linux. */
export function buildSandboxChildEnvironment(explicitEnv?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const linux = process.platform === "linux"
  const inherited = linux ? scrubSocketEnvVars(process.env) : process.env
  const supplied = linux && explicitEnv !== undefined ? scrubSocketEnvVars(explicitEnv) : explicitEnv
  const childEnv: NodeJS.ProcessEnv = { ...inherited, ...supplied, SLATE_SANDBOX: "native" }

  if (linux) Object.assign(childEnv, withConfiguredRipgrepEnv(childEnv))
  return childEnv
}

export function buildSandboxSpawnOptions(
  options: HelperShellOptions,
  executionCwd: string,
): Pick<SpawnOptions, "cwd" | "env" | "stdio"> {
  return {
    cwd: options.cwd || executionCwd,
    env: buildSandboxChildEnvironment(options.env),
    stdio: options.stdio || ["pipe", "pipe", "pipe"],
  }
}
