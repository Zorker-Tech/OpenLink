import { promises as fs } from "node:fs";

import { readLocalExecDaemonDiscovery } from "./daemon-discovery-read.ts";
import type { LocalExecDaemonDiscovery } from "./daemon-files-contracts.ts";
import { removeLocalExecDaemonFile } from "./daemon-files-write.ts";

function sameDaemonGeneration(current: LocalExecDaemonDiscovery, expected: LocalExecDaemonDiscovery): boolean {
  return current.pid === expected.pid
    && current.startedAt === expected.startedAt
    && current.entryRealpath === expected.entryRealpath
    && current.generationToken === expected.generationToken;
}

function isMissingPath(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

export async function removeLocalExecDaemonDiscoveryIfMatches(
  path: string,
  expected: LocalExecDaemonDiscovery,
): Promise<boolean> {
  const retiredPath = `${path}.${process.pid}.${Date.now()}.retired`;
  try {
    await fs.rename(path, retiredPath);
  } catch (error) {
    if (isMissingPath(error)) return false;
    throw error;
  }

  try {
    const retiredRecord = await readLocalExecDaemonDiscovery(retiredPath);
    if (retiredRecord !== null && sameDaemonGeneration(retiredRecord, expected)) return true;
    try {
      await fs.link(retiredPath, path);
    } catch (error) {
      if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "EEXIST") throw error;
    }
    return false;
  } finally {
    await removeLocalExecDaemonFile(retiredPath);
  }
}
