/**
 * The secrets a host keeps for itself.
 *
 * The machine's own identifier is minted once and remembered, and every secret is written atomically into the host's
 * own directory, so a reader either sees the whole value or none of it.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { getHostSecretsPath } from "./host-paths.ts";

let cachedMachineId: string | undefined;

export async function getOrCreateHostMachineId(path = getHostSecretsPath()): Promise<string> {
  if (cachedMachineId !== undefined) return cachedMachineId;

  const persistedId = await readMachineId(path);
  if (persistedId !== null) {
    cachedMachineId = persistedId;
    return persistedId;
  }

  const newId = randomUUID();
  await writeMachineId(path, newId);
  cachedMachineId = newId;
  return newId;
}

export async function readMachineId(path: string): Promise<string | null> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
  if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) return null;
  const candidate = (decoded as Record<string, unknown>).machineId;
  return typeof candidate === "string" && candidate.length > 0 ? candidate : null;
}

export async function writeMachineId(path: string, machineId: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const stagingPath = `${path}.${process.pid}.tmp`;
  const serialized = JSON.stringify({ machineId }, null, 2);
  await writeFile(stagingPath, serialized, "utf8");
  await rename(stagingPath, path);
}

/** Test-only reset; production never clears the process-global machine identity. */
export function clearHostMachineIdCacheForTests(): void {
  cachedMachineId = undefined;
}
