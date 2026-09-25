/**
 * Finding the executable a command name refers to.
 *
 * A bare name has to be resolved against `PATH` (and on Windows, against the extensions a command can
 * carry) before it can be spawned, and the answer is remembered: a tool is looked up once per
 * process, not once per invocation, which matters when a run spawns hundreds of short commands.
 */

import fs from "node:fs"
import path from "node:path"

import { LRUCache } from "lru-cache"

const isWindows = typeof process !== "undefined" && process.platform === "win32"
const WINDOWS_EXTENSIONS = [".exe", ".bat", ".cmd", ".ps1"]
const LOOKUP_CACHE_SIZE = 512

const resolvedPaths = new LRUCache<string, string>({ max: LOOKUP_CACHE_SIZE })

function statQuietly(file: string): fs.Stats | null {
  try {
    return fs.statSync(file)
  } catch {
    return null
  }
}

/** A path with a separator is already resolved; a bare name is searched for on `PATH`. */
function searchPath(executable: string, pathMustMatch?: RegExp): string {
  if (executable.match(/[\\/]/)) return executable
  const cacheKey = pathMustMatch ? `${executable}\0${pathMustMatch.source}\0${pathMustMatch.flags}` : executable
  const cached = resolvedPaths.get(cacheKey)
  if (cached !== undefined) return cached

  const local = path.join(".", executable)
  if (statQuietly(local)) {
    resolvedPaths.set(cacheKey, local)
    return local
  }
  const haystack = (process.env.PATH ?? "").split(isWindows ? ";" : ":")
  for (const entry of haystack) {
    const candidate = path.join(entry, executable)
    if (statQuietly(candidate) && (!pathMustMatch || pathMustMatch.test(candidate))) {
      resolvedPaths.set(cacheKey, candidate)
      return candidate
    }
  }
  resolvedPaths.set(cacheKey, executable)
  return executable
}

export function findActualExecutable(
  executable: string,
  args: string[],
  pathMustMatch?: RegExp,
): { cmd: string; args: string[] } {
  if (process.platform !== "win32") return { cmd: searchPath(executable, pathMustMatch), args }
  if (!fs.existsSync(executable)) {
    const lower = executable.toLowerCase()
    if (WINDOWS_EXTENSIONS.some(extension => lower.endsWith(extension))) {
      const resolved = searchPath(executable, pathMustMatch)
      if (fs.existsSync(resolved)) return findActualExecutable(resolved, args, pathMustMatch)
    }
    for (const extension of WINDOWS_EXTENSIONS) {
      const candidate = searchPath(`${executable}${extension}`, pathMustMatch)
      if (fs.existsSync(candidate)) return findActualExecutable(candidate, args, pathMustMatch)
    }
  }
  // Scripts cannot be spawned directly on Windows: they are handed to their interpreter.
  if (executable.match(/\.ps1$/i)) {
    const cmd = path.join(process.env.SYSTEMROOT ?? "", "System32", "WindowsPowerShell", "v1.0", "PowerShell.exe")
    return {
      cmd,
      args: ["-ExecutionPolicy", "Unrestricted", "-NoLogo", "-NonInteractive", "-File", executable, ...args],
    }
  }
  if (executable.match(/\.(bat|cmd)$/i)) {
    const cmd = path.join(process.env.SYSTEMROOT ?? "", "System32", "cmd.exe")
    return { cmd, args: ["/C", executable, ...args] }
  }
  if (executable.match(/\.js$/i)) return { cmd: process.execPath, args: [executable, ...args] }
  return { cmd: executable, args }
}
