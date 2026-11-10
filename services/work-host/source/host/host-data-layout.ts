import { homedir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"
import { getSlateVariant } from "../shared/node/slate-variant.ts"

export const SLATE_DATA_ROOT_ENV = "SLATE_DATA_ROOT"
export const SLATE_PRODUCTION_DATA_DIRNAME = ".slate"
export const SLATE_USER_DATA_DIR_ENV = "SLATE_USER_DATA_DIR"
export const SLATE_DATA_DIRNAME = "slate-data"
export const USER_DATA_DIR_FLAG = "--user-data-dir"

export function readUserDataDirArg(argv: readonly string[]): string | null {
  for (let index = 0; index < argv.length; index += 1) {
    const candidate = argv[index]
    if (candidate === undefined) continue

    if (candidate === USER_DATA_DIR_FLAG) {
      const value = argv[index + 1]
      return value == null || value.startsWith("--") ? null : value
    }
    if (candidate.startsWith(`${USER_DATA_DIR_FLAG}=`)) {
      return candidate.slice(USER_DATA_DIR_FLAG.length + 1)
    }
  }
  return null
}

export function resolveSlateUserDataDir(
  argv: readonly string[] = [],
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): string | null {
  const configured = readUserDataDirArg(argv) ?? env[SLATE_USER_DATA_DIR_ENV]
  const path = configured?.trim()
  if (path == null || path.length === 0) return null
  return isAbsolute(path) ? path : resolve(cwd, path)
}

export function getSlateProductionRootDir(homeDir = homedir()): string {
  return join(homeDir, SLATE_PRODUCTION_DATA_DIRNAME)
}

export function resolveSlateDataRootOverride(env: NodeJS.ProcessEnv = process.env): string | null {
  const path = env[SLATE_DATA_ROOT_ENV]?.trim()
  return path != null && path.length > 0 && isAbsolute(path) ? path : null
}

export function getSlateRootDir(homeDir = homedir()): string {
  const explicitRoot = resolveSlateDataRootOverride()
  if (explicitRoot !== null) return explicitRoot

  const userRoot = resolveSlateUserDataDir([], process.env)
  if (userRoot !== null) return join(userRoot, SLATE_DATA_DIRNAME)

  const variant = getSlateVariant()
  return variant === "slate"
    ? getSlateProductionRootDir(homeDir)
    : join(homeDir, SLATE_PRODUCTION_DATA_DIRNAME, variant)
}

export function getGatewayDiscoveryPath(homeDir = homedir()): string {
  return join(getSlateRootDir(homeDir), "gateway.json")
}

export function getHostLockPath(homeDir = homedir()): string {
  return join(getSlateRootDir(homeDir), "host.lock")
}

export function getHostSecretsPath(homeDir = homedir()): string {
  return join(getSlateRootDir(homeDir), "host-secrets.json")
}

export function getHostUpgradeMarkerPath(homeDir = homedir()): string {
  return join(getSlateRootDir(homeDir), ".slate-host-upgrade.json")
}

export function getHostCrashMarkerPath(homeDir = homedir()): string {
  return join(getSlateRootDir(homeDir), ".slate-host-crash.json")
}
