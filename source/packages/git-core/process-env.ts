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

const PINNED_GIT_CONFIG_ENTRIES = [
  ["safe.bareRepository", "explicit"],
  ["core.fsmonitor", "false"],
  ["core.hooksPath", devNull],
  ["core.attributesFile", devNull],
] as const

function readGitConfigCount(env: NodeJS.ProcessEnv): number {
  const raw = env.GIT_CONFIG_COUNT
  if (raw === undefined || raw === "") return 0
  const parsed = Number.parseInt(String(raw), 10)
  return !Number.isFinite(parsed) || parsed < 0 ? 0 : parsed
}

function applyPinnedGitConfig(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const count = readGitConfigCount(env)
  const result = { ...env }
  const foundKeys = new Set<string>()
  for (let index = 0; index < count; index++) {
    const existingKey = result[`GIT_CONFIG_KEY_${index}`]
    for (const [pinnedKey, pinnedValue] of PINNED_GIT_CONFIG_ENTRIES) {
      if (existingKey === pinnedKey) {
        result[`GIT_CONFIG_VALUE_${index}`] = pinnedValue
        foundKeys.add(pinnedKey)
      }
    }
  }
  let nextIndex = count
  for (const [pinnedKey, pinnedValue] of PINNED_GIT_CONFIG_ENTRIES) {
    if (foundKeys.has(pinnedKey)) continue
    result[`GIT_CONFIG_KEY_${nextIndex}`] = pinnedKey
    result[`GIT_CONFIG_VALUE_${nextIndex}`] = pinnedValue
    nextIndex++
  }
  if (nextIndex !== count) result.GIT_CONFIG_COUNT = String(nextIndex)
  return result
}

export function createGitProcessEnv(options: {
  readonly spawnerEnv?: NodeJS.ProcessEnv | undefined
  readonly optionsEnv?: NodeJS.ProcessEnv | undefined
  readonly command?: string | undefined
}): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = {
    ...process.env,
    ...options.spawnerEnv,
    LC_ALL: "en_US.UTF-8",
    LANG: "en_US.UTF-8",
    GIT_PAGER: "cat",
    ...options.optionsEnv,
  }
  if (options.command !== undefined) merged.SLATE_GIT_COMMAND = options.command
  else delete merged.SLATE_GIT_COMMAND
  return applyPinnedGitConfig(merged)
}
