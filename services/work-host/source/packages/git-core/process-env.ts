/**
 * The environment a git child process runs in.
 *
 * Git reads configuration from the environment as well as from files, and a repository is untrusted
 * input: a bare repository in a directory git is pointed at, a filesystem monitor, a hook path, an
 * attributes file — each of those is a way for the repository to run code or reach outside itself.
 * Four of them are therefore pinned explicitly rather than left to whatever the machine is configured
 * with, and the caller's own `GIT_CONFIG_*` entries are rewritten in place when they name one of the
 * pinned keys, so a pinned value cannot be overridden from outside.
 *
 * The locale is pinned so git's output parses, the pager is disabled because nothing here is a
 * terminal, and the command that invoked git is passed through under our own variable so a hook can
 * tell where it came from.
 */

import { devNull } from "node:os"

const REQUIRED_CONFIG_VALUES = [
  ["safe.bareRepository", "explicit"],
  ["core.fsmonitor", "false"],
  ["core.hooksPath", devNull],
  ["core.attributesFile", devNull],
] as const

const REQUIRED_CONFIG_BY_NAME = new Map<string, string>(REQUIRED_CONFIG_VALUES)

function existingConfigCount(environment: NodeJS.ProcessEnv): number {
  const encoded = environment.GIT_CONFIG_COUNT
  if (!encoded) return 0
  const count = Number.parseInt(encoded, 10)
  return Number.isFinite(count) && count >= 0 ? count : 0
}

function enforceRequiredGitConfig(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const output = { ...environment }
  const count = existingConfigCount(environment)
  const alreadySet = new Set<string>()

  for (let slot = 0; slot < count; slot++) {
    const key = output[`GIT_CONFIG_KEY_${slot}`]
    const requiredValue = key === undefined ? undefined : REQUIRED_CONFIG_BY_NAME.get(key)
    if (key === undefined || requiredValue === undefined) continue
    output[`GIT_CONFIG_VALUE_${slot}`] = requiredValue
    alreadySet.add(key)
  }

  let slot = count
  let appended = 0
  for (const [key, value] of REQUIRED_CONFIG_VALUES) {
    if (alreadySet.has(key)) continue
    output[`GIT_CONFIG_KEY_${slot}`] = key
    output[`GIT_CONFIG_VALUE_${slot}`] = value
    slot += 1
    appended += 1
  }

  if (appended > 0) output.GIT_CONFIG_COUNT = String(slot)
  return output
}

export function createGitProcessEnv(options: {
  readonly spawnerEnv?: NodeJS.ProcessEnv | undefined
  readonly optionsEnv?: NodeJS.ProcessEnv | undefined
  readonly command?: string | undefined
}): NodeJS.ProcessEnv {
  const childEnvironment: NodeJS.ProcessEnv = Object.assign({}, process.env)
  Object.assign(childEnvironment, options.spawnerEnv, {
    LC_ALL: "en_US.UTF-8",
    LANG: "en_US.UTF-8",
    GIT_PAGER: "cat",
  }, options.optionsEnv)

  if (options.command === undefined) delete childEnvironment.SLATE_GIT_COMMAND
  else childEnvironment.SLATE_GIT_COMMAND = options.command

  return enforceRequiredGitConfig(childEnvironment)
}
