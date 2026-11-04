import { isAbsolute } from "node:path";

/** Whether an install-relative path stays inside its selected root. */
export function isPathSafe(candidatePath: string): boolean {
  return !candidatePath.includes("..") && !isAbsolute(candidatePath) && !candidatePath.includes("://");
}
