import { execFile } from "node:child_process"
import { promisify } from "node:util"

import { createGitProcessEnv } from "./process-env.ts"

const execute = promisify(execFile)
const ARGUMENT_OPTIONS = new Set(["-c", "-C", "--git-dir", "--work-tree"])

export function findGitSubcommand(arguments_: readonly string[]): string | undefined {
  let operandBelongsToOption = false

  for (const value of arguments_) {
    if (operandBelongsToOption) {
      operandBelongsToOption = false
      continue
    }

    if (ARGUMENT_OPTIONS.has(value)) {
      operandBelongsToOption = true
      continue
    }

    if (value.startsWith("-")) continue
    return value
  }

  return undefined
}

function gitEnvironment(arguments_: readonly string[], supplied: NodeJS.ProcessEnv | undefined) {
  return createGitProcessEnv({
    command: findGitSubcommand(arguments_),
    optionsEnv: supplied,
  })
}

export interface GitExecFileOptions {
  readonly cwd?: string | undefined
  readonly env?: NodeJS.ProcessEnv | undefined
  readonly encoding?: BufferEncoding | undefined
  readonly timeout?: number | undefined
  readonly killSignal?: NodeJS.Signals | number | undefined
}

export async function gitExecFile(
  file: string,
  arguments_: readonly string[],
  options?: GitExecFileOptions,
): Promise<{ stdout: string; stderr: string }> {
  const { env: supplied, encoding = "utf8", ...processOptions } = options ?? {}
  const result = await execute(file, Array.from(arguments_), {
    ...processOptions,
    encoding,
    env: gitEnvironment(arguments_, supplied),
  })

  return {
    stdout: String(result.stdout),
    stderr: String(result.stderr),
  }
}
