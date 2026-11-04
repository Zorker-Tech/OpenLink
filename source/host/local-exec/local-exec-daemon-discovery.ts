import { promises as fs } from "node:fs";
import { findSystemErrno } from "../../shared/system-errno.ts";
import type { LocalExecDiscovery } from "./local-exec-daemon-contracts.ts";
import {
  getLocalExecDaemonDiscoveryPath,
  readLocalExecDaemonDiscovery,
  writeDaemonJsonFile,
} from "./local-exec-daemon-files.ts";

function identityMatches(observed: LocalExecDiscovery | null, expected: LocalExecDiscovery): boolean {
  return observed !== null
    && observed.pid === expected.pid
    && observed.startedAt === expected.startedAt
    && observed.entryRealpath === expected.entryRealpath
    && observed.generationToken === expected.generationToken;
}

function isAlreadyRestored(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "EEXIST";
}

export function writeLocalExecDaemonDiscovery(
  info: LocalExecDiscovery,
  path = getLocalExecDaemonDiscoveryPath(),
): Promise<void> {
  return writeDaemonJsonFile(path, info, { pretty: true });
}

export async function clearLocalExecDaemonDiscovery(path = getLocalExecDaemonDiscoveryPath()): Promise<void> {
  await fs.rm(path, { force: true });
}

/** Retire only the exact process identity observed earlier, restoring a newer file if it replaced this one. */
export async function clearLocalExecDaemonDiscoveryIfMatches(
  expected: LocalExecDiscovery,
  path = getLocalExecDaemonDiscoveryPath(),
): Promise<boolean> {
  const quarantinePath = `${path}.${process.pid}.${Date.now()}.retired`;
  try {
    await fs.rename(path, quarantinePath);
  } catch (error) {
    if (findSystemErrno(error) === "ENOENT") return false;
    throw error;
  }

  try {
    const observed = await readLocalExecDaemonDiscovery(quarantinePath);
    if (identityMatches(observed, expected)) return true;
    await restoreIfStillVacant(quarantinePath, path);
    return false;
  } finally {
    await fs.rm(quarantinePath, { force: true });
  }
}

async function restoreIfStillVacant(quarantinePath: string, livePath: string): Promise<void> {
  try {
    await fs.link(quarantinePath, livePath);
  } catch (error) {
    if (!isAlreadyRestored(error)) throw error;
  }
}
