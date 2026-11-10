/**
 * Where the search binary is, and how a command is told about it.
 *
 * The binary is configured once at startup, since where it lives is a property of the installation rather
 * than of a command. What a command needs is two things: the directory it lives in at the front of the
 * search path, so a script that calls it by name finds the configured one rather than another, and the path
 * itself in the environment, for anything that asks for it directly. A path that is not absolute is not
 * configured at all, since a relative one would mean something different in every working directory.
 */

import { isAbsolute } from "node:path"
import { prependExecutableDirectory } from "./ripgrep-environment-policy.ts"

let configuredPath: string | undefined

export function withConfiguredRipgrepEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (!configuredPath || !isAbsolute(configuredPath)) {
    return env
  }
  return {
    ...prependExecutableDirectory(env, configuredPath),
    SLATE_RIPGREP_PATH: configuredPath,
  }
}

export function getRipgrepBinaryPath(): string {
  if (!configuredPath) {
    throw new Error("Ripgrep path not configured. Call configureRipgrepPath() at startup.")
  }
  return configuredPath
}
