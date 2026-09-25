/**
 * Finding the shell binaries this machine has, whichever platform it is.
 *
 * The platform does not ship a shell: it drives the ones the user has, and where they are differs by
 * platform. On Windows bash comes from Git, so a hint from the user's terminal is trusted only when it
 * points at one, and the fallback is the Git installation itself — a plain `bash` on Windows is the one that
 * ships with the system and does not behave like the shell commands are written for. PowerShell is looked
 * for as the modern binary first and the built-in one second, and zsh is taken from the user's own shell
 * when that is what they use.
 */

import { existsSync } from "node:fs"
import path from "node:path"

import { findActualExecutable } from "../utils/executable-lookup.ts"

export function getBashPath(userTerminalHint?: string): string | null {
  if (process.platform === "win32") {
    const pathMustMatch = /git.*bash/i
    if (userTerminalHint && pathMustMatch.test(userTerminalHint)) return userTerminalHint
    const gitBashPath = findActualExecutable("bash", [], pathMustMatch).cmd
    if (pathMustMatch.test(gitBashPath)) return gitBashPath
    // A bash that is not Git's is the Windows one, which is not the shell commands are written for.
    return null
  }
  const shell = process.env.SHELL
  if (shell?.includes("bash")) return shell
  return findActualExecutable("bash", []).cmd
}

/** A Windows path as the same file seen from inside Git Bash. */
export function windowsPathToGitBash(windowsPath: string): string {
  if (process.platform !== "win32") return windowsPath
  const normalized = path.normalize(windowsPath)
  const driveLetter = normalized[0]?.toLowerCase()
  if (driveLetter && normalized[1] === ":" && normalized[2] === path.sep) {
    return `/${driveLetter}${normalized.slice(2).replace(/\\/g, "/")}`
  }
  return normalized.replace(/\\/g, "/")
}

export function getPowerShellExecutable(): string {
  if (process.platform !== "win32") {
    const shell = process.env.SHELL
    if (shell?.includes("pwsh") || shell?.includes("powershell")) return shell
  }
  let executable = findActualExecutable("pwsh", []).cmd
  if (executable !== "pwsh") return executable
  executable = findActualExecutable("powershell", []).cmd
  if (executable !== "powershell") return executable
  if (process.platform === "win32") {
    // The built-in one is not on the PATH on every installation, so its usual place is tried as well.
    executable = path.join(process.env.SYSTEMROOT!, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    if (existsSync(executable)) return executable
  }
  throw new Error("Neither 'pwsh' (PowerShell Core) nor 'powershell' (Windows PowerShell) found in PATH")
}

export function getZshPath(): string {
  const shell = process.env.SHELL
  if (shell?.includes("zsh")) return shell
  return findActualExecutable("zsh", []).cmd
}
