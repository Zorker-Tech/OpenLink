import { join, relative } from "node:path"
import { isPathWithin } from "../shared/node/paths.ts"
import { getSlateRootDir, SLATE_DATA_DIRNAME } from "./host-data-layout.ts"

export const SLATE_BOX_HOME_DIR = "/home/box"
export const SLATE_BOX_DATA_ROOT = `${SLATE_BOX_HOME_DIR}/${SLATE_DATA_DIRNAME}`
export const SLATE_BOX_MODEL_VISIBLE_DATA_ROOT = `${SLATE_BOX_HOME_DIR}/agent-data`

export function toModelVisiblePath(path: string): string {
  if (!isPathWithin(SLATE_BOX_DATA_ROOT, path, { isInclusive: true })) return path
  return join(SLATE_BOX_MODEL_VISIBLE_DATA_ROOT, relative(SLATE_BOX_DATA_ROOT, path))
}

const LEGACY_ROOT_SEGMENT = /[/\\]\.slate(?:-[^/\\]+)?[/\\](.+)$/

export function reanchorSlatePath(storedPath: string): string {
  const currentRoot = getSlateRootDir()
  if (isPathWithin(currentRoot, storedPath, { isInclusive: true })) return storedPath

  const suffix = LEGACY_ROOT_SEGMENT.exec(storedPath)?.[1]
  if (suffix == null) return storedPath
  const relativeParts = suffix.split(/[/\\]+/)
  if (relativeParts.some((part) => part === "." || part === "..")) return storedPath
  return join(currentRoot, ...relativeParts)
}
