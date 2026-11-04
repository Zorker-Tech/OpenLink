import { isAbsolute } from "node:path";

import { resolveRealPathStrict } from "../utils/paths.ts";

function absoluteCandidate(pathValue: string): string | null {
  return isAbsolute(pathValue) ? pathValue : null;
}

async function canonicalIgnoreTarget(pathValue: string): Promise<string | null> {
  const candidate = absoluteCandidate(pathValue);
  if (candidate === null) return null;
  return resolveRealPathStrict(candidate);
}

export async function resolvePathForIgnoreService(pathValue: string): Promise<string | null> {
  return canonicalIgnoreTarget(pathValue);
}
