/**
 * Running one git command and reading what it said.
 *
 * The subcommand is picked out of the arguments first — past the options that take a value of their
 * own — because it is what the environment hands to the hooks git may run. Everything else is the
 * platform's own child process handling: no shell, a pinned environment, and output decoded as text.
 */

import { execFile } from "node:child_process"
import { promisify } from "node:util"

import { createGitProcessEnv } from "./process-env.ts"

const execFileAsync = promisify(execFile)

const OPTIONS_WITH_VALUE = new Set(["-c", "-C", "--git-dir", "--work-tree"])

function gitSubcommand(args: readonly string[]): string | undefined {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (OPTIONS_WITH_VALUE.has(arg)) {
      index++
      continue
    }
    if (arg.startsWith("-")) continue
    return arg
  }
  return undefined
}

function withGitEnv(args: readonly string[], env: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  return createGitProcessEnv({ command: gitSubcommand(args), optionsEnv: env })
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
  args: readonly string[],
  options?: GitExecFileOptions,
): Promise<{ stdout: string; stderr: string }> {
  const { env, encoding = "utf8", ...rest } = options ?? {}
  const result = await execFileAsync(file, [...args], {
    ...rest,
    encoding,
    env: withGitEnv(args, env),
  })
  return { stdout: String(result.stdout), stderr: String(result.stderr) }
}
