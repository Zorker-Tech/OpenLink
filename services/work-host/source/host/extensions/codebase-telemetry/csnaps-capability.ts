/**
 * Whether the codebase-telemetry helper is there to be run.
 *
 * The helper lives beside the host bundle unless an override names it, and the capability it reports says where it is
 * and whether it can be executed at all.
 */
import { accessSync, constants, statSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const bundledHelperPath = ["extensions", "codebase-telemetry", "csnaps"] as const

function hostBundleDirectory(): string {
  if (typeof __dirname === "string") return __dirname
  return dirname(fileURLToPath(import.meta.url))
}

export function csnapsPath(env: NodeJS.ProcessEnv = process.env): string {
  const configuredPath = env.SLATE_CSNAPS_BIN?.trim()
  return configuredPath || join(hostBundleDirectory(), ...bundledHelperPath)
}

type UnavailableReason = "missing" | "not-file" | "not-executable"
type Capability =
  | { readonly available: true; readonly executablePath: string }
  | { readonly available: false; readonly executablePath: string; readonly reason: UnavailableReason }

function unavailable(executablePath: string, reason: UnavailableReason): Capability {
  return { available: false, executablePath, reason }
}

export function csnapsAvailability(env: NodeJS.ProcessEnv = process.env): Capability {
  const executablePath = csnapsPath(env)
  let targetIsFile: boolean
  try {
    targetIsFile = statSync(executablePath).isFile()
  } catch {
    return unavailable(executablePath, "missing")
  }
  if (!targetIsFile) return unavailable(executablePath, "not-file")
  try {
    accessSync(executablePath, constants.X_OK)
  } catch {
    return unavailable(executablePath, "not-executable")
  }
  return { available: true, executablePath }
}
