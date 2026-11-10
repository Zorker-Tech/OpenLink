import { lstat, readlink, rm, symlink } from "node:fs/promises"
import { findSystemErrno } from "../shared/system-errno.ts"

async function lookupAlias(path: string) {
  try {
    return await lstat(path)
  } catch (error) {
    if (findSystemErrno(error) !== "ENOENT") throw error
    return null
  }
}

/** Keep the legacy alias pointed at the selected state root without replacing an occupied real path. */
export async function ensureDataRootAlias(args: { readonly dataRoot: string; readonly aliasPath: string }): Promise<void> {
  const existing = await lookupAlias(args.aliasPath)
  if (existing !== null) {
    if (!existing.isSymbolicLink()) return
    if (await readlink(args.aliasPath) === args.dataRoot) return
    await rm(args.aliasPath)
  }
  await symlink(args.dataRoot, args.aliasPath)
}
