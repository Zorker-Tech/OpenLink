import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { FeatureFlagName } from "./experiment-config.gen.ts";
import { isFlagName, type TimedFeatureFlagOverride } from "./feature-flag-override-state.ts";

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}

export function readFeatureFlagOverrideSnapshot(
  path: string,
  now: number,
): Map<FeatureFlagName, TimedFeatureFlagOverride> | undefined {
  if (!existsSync(path)) return undefined;
  const document = objectRecord(JSON.parse(readFileSync(path, "utf8")));
  const rawOverrides = objectRecord(document?.overrides);
  if (rawOverrides === undefined) return undefined;

  const active = new Map<FeatureFlagName, TimedFeatureFlagOverride>();
  for (const [name, value] of Object.entries(rawOverrides)) {
    const entry = objectRecord(value);
    if (!isFlagName(name) || entry === undefined) continue;
    if (typeof entry.value !== "boolean" || typeof entry.expiresAtMs !== "number" || entry.expiresAtMs <= now) continue;
    active.set(name, { value: entry.value, expiresAtMs: entry.expiresAtMs });
  }
  return active;
}

export async function writeFeatureFlagOverrideSnapshot(
  path: string,
  overrides: Record<string, TimedFeatureFlagOverride>,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, JSON.stringify({ overrides }), "utf8");
  await rename(temporaryPath, path);
}
