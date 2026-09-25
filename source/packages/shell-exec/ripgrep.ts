/**
 * Where the search binary is, and how a command is told about it.
 *
 * The binary is configured once at startup, since where it lives is a property of the installation rather
 * than of a command. What a command needs is two things: the directory it lives in at the front of the
 * search path, so a script that calls it by name finds the configured one rather than another, and the path
 * itself in the environment, for anything that asks for it directly. A path that is not absolute is not
 * configured at all, since a relative one would mean something different in every working directory.
 */

import { delimiter, dirname, isAbsolute } from "node:path"

/** The search path's variable is spelled differently on Windows, and only one spelling is kept. */
function findPathEnvKey(env: NodeJS.ProcessEnv): string | undefined {
  const pathKeys = Object.keys(env).filter((key) => key.toLowerCase() === "path")
  if (pathKeys.length === 0) {
    return undefined
  }
  if (process.platform === "win32") {
    return pathKeys.find((key) => key === "Path") ?? pathKeys[0]
  }
  return pathKeys.find((key) => key === "PATH") ?? pathKeys[0]
}

function getPathEnvValue(env: NodeJS.ProcessEnv): string {
  const pathKey = findPathEnvKey(env)
  return pathKey !== undefined ? env[pathKey] ?? "" : ""
}

function setPathEnvValue(env: NodeJS.ProcessEnv, pathValue: string): NodeJS.ProcessEnv {
  const pathKey = findPathEnvKey(env) ?? (process.platform === "win32" ? "Path" : "PATH")
  const result = { ...env }
  // A second spelling of the same variable would shadow the one that was set.
  for (const key of Object.keys(result)) {
    if (key !== pathKey && key.toLowerCase() === "path") {
      delete result[key]
    }
  }
  result[pathKey] = pathValue
  return result
}

function prependExecutableDirToPath(env: NodeJS.ProcessEnv, executablePath: string): NodeJS.ProcessEnv {
  const executableDir = dirname(executablePath)
  if (!executableDir || executableDir === ".") {
    return env
  }
  const currentPathEntries = getPathEnvValue(env).split(delimiter).filter(Boolean)
  // The directory is put first and not repeated, so the configured binary wins over any other.
  const newPathValue = [executableDir, ...currentPathEntries.filter((entry) => entry !== executableDir)].join(delimiter)
  return setPathEnvValue(env, newPathValue)
}

let configuredPath: string | undefined

export function withConfiguredRipgrepEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (!configuredPath || !isAbsolute(configuredPath)) {
    return env
  }
  return {
    ...prependExecutableDirToPath(env, configuredPath),
    SLATE_RIPGREP_PATH: configuredPath,
  }
}

export function getRipgrepBinaryPath(): string {
  if (!configuredPath) {
    throw new Error("Ripgrep path not configured. Call configureRipgrepPath() at startup.")
  }
  return configuredPath
}
