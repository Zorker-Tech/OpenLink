/** Apply the caller's sandbox choice before starting a child process. */

import type { ChildProcess, SpawnOptions } from "node:child_process";

import { filterElectronEnv } from "../env-filter.ts";
import { getSandboxCacheEnv } from "./cache-environment.ts";
import { SandboxUnsupportedError } from "./errors.ts";
import {
  getLastSandboxFailureReason,
  isSandboxHelperSupported,
  spawnWithSandboxHelper,
  type SandboxHelperPolicy,
} from "./helper-support.ts";
import { spawnUnsafe } from "./unsafe-spawn.ts";

export type SandboxExecutionPolicy = SandboxHelperPolicy;

function applyProcessEnvironment(
  options: SpawnOptions,
  policy: SandboxExecutionPolicy,
): SpawnOptions {
  const supplied = filterElectronEnv(options.env);
  options.env = supplied;
  if (!policy.enableSharedBuildCache) return options;

  return {
    ...options,
    env: {
      ...filterElectronEnv(process.env),
      ...getSandboxCacheEnv(),
      ...supplied,
    },
  };
}

function startConstrainedProcess(
  command: string,
  args: readonly string[],
  options: SpawnOptions,
  policy: SandboxExecutionPolicy,
): ChildProcess {
  if (isSandboxHelperSupported()) return spawnWithSandboxHelper(command, args, options, policy);

  const reason = getLastSandboxFailureReason();
  const detail = reason ?? "Sandbox availability could not be confirmed.";
  throw new SandboxUnsupportedError(
    `The requested policy "${policy.type}" cannot be enforced here. The command was not started. ${detail}`,
    reason ?? undefined,
  );
}

export function spawnInSandbox(
  command: string,
  args: readonly string[] = [],
  options: SpawnOptions = {},
  sandboxPolicy: SandboxExecutionPolicy,
): ChildProcess {
  const spawnOptions = applyProcessEnvironment(options, sandboxPolicy);
  if (sandboxPolicy.type === "insecure_none") return spawnUnsafe(command, args, spawnOptions);
  return startConstrainedProcess(command, args, spawnOptions, sandboxPolicy);
}
