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
import type { ShellPathResolutionPorts } from "./platform-shell-contracts.ts"
import {
  resolveBashExecutable,
  resolvePowerShellExecutable,
  resolveZshExecutable,
  toGitShellPath,
} from "./platform-shell-policy.ts"

export function currentShellPathPorts(): ShellPathResolutionPorts {
  return {
    platform: process.platform,
    ...(process.env.SHELL === undefined ? {} : { shell: process.env.SHELL }),
    ...(process.env.SYSTEMROOT === undefined ? {} : { systemRoot: process.env.SYSTEMROOT }),
    findExecutable: (name, matcher) => findActualExecutable(name, [], matcher).cmd,
    exists: existsSync,
    join: (...parts) => path.join(...parts),
  }
}

export function getBashPath(userTerminalHint?: string): string | null {
  return resolveBashExecutable(currentShellPathPorts(), userTerminalHint)
}

/** A Windows path expressed in Git Bash's slash-rooted form. */
export function windowsPathToGitBash(windowsPath: string): string {
  return toGitShellPath(windowsPath, process.platform)
}

export function getPowerShellExecutable(): string {
  return resolvePowerShellExecutable(currentShellPathPorts())
}

export function getZshPath(): string {
  return resolveZshExecutable(currentShellPathPorts())
}
