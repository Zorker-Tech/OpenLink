/**
 * The path an ignore service is asked about.
 *
 * The service matches on real paths, so a path is resolved through its symlinks first; a path that cannot be resolved
 * is not a path the service can be asked about, and a relative one is not either.
 */
import { isAbsolute } from "node:path";
import { resolveRealPathStrict } from "../utils/paths.ts";

function makeResolvedIgnorePath(path: string): string {
  return path;
}

export async function resolvePathForIgnoreService(absolutePath: string): Promise<string | null> {
  if (!isAbsolute(absolutePath)) return null;
  const resolved = await resolveRealPathStrict(absolutePath);
  if (resolved === null) return null;
  return makeResolvedIgnorePath(resolved);
}
