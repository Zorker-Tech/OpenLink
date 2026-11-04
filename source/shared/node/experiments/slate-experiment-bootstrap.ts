import { existsSync, readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { errorLogTag } from "../../errors/summary.ts";
import { reportExperimentsDiagnostic } from "./experiments-diagnostics.ts";

export const BOOTSTRAP_CACHE_FILENAME = "slate-experiment-bootstrap.json";

export interface CachedExperimentBootstrap {
  readonly config: string;
  readonly userId: string | null;
  readonly fetchedAtMs?: number;
}

export function bootstrapCachePath(cacheDir: string): string {
  return join(cacheDir, BOOTSTRAP_CACHE_FILENAME);
}

function cacheEntry(value: unknown): CachedExperimentBootstrap | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const fields = value as Record<string, unknown>;
  if (typeof fields.config !== "string") return null;

  const fetchedAtMs = fields.fetchedAtMs;
  return {
    config: fields.config,
    userId: typeof fields.userId === "string" ? fields.userId : null,
    ...(typeof fetchedAtMs === "number" && Number.isFinite(fetchedAtMs) && fetchedAtMs >= 0
      ? { fetchedAtMs }
      : {}),
  };
}

/** Read the last complete bootstrap without letting a damaged cache block startup. */
export function loadCachedBootstrap(cacheDir: string): CachedExperimentBootstrap | null {
  try {
    const path = bootstrapCachePath(cacheDir);
    if (!existsSync(path)) return null;
    return cacheEntry(JSON.parse(readFileSync(path, "utf8")) as unknown);
  } catch (error) {
    reportExperimentsDiagnostic({
      kind: "bootstrap_cache_read_failed",
      errorClass: errorLogTag(error),
    });
    return null;
  }
}

/** Replace the cache atomically so a stopped host cannot leave a half-written configuration. */
export async function saveCachedBootstrap(
  cacheDir: string,
  value: CachedExperimentBootstrap,
): Promise<void> {
  try {
    const path = bootstrapCachePath(cacheDir);
    const temporaryPath = path + "." + String(process.pid) + ".tmp";
    await mkdir(dirname(path), { recursive: true });
    await writeFile(temporaryPath, JSON.stringify(value), "utf8");
    await rename(temporaryPath, path);
  } catch (error) {
    reportExperimentsDiagnostic({
      kind: "bootstrap_cache_write_failed",
      errorClass: errorLogTag(error),
    });
  }
}
