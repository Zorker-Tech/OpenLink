import { promises as fs } from "node:fs";

import type { LocalExecDaemonDiscovery } from "./daemon-files-contracts.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

function isFileMissing(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function optionalNonEmptyString(value: unknown): value is string | undefined {
  return value === undefined || (typeof value === "string" && value.length > 0);
}

export function parseDiscovery(value: unknown): LocalExecDaemonDiscovery | null {
  if (!isRecord(value)) return null;
  const processId = value.pid;
  const launchedAt = value.startedAt;
  const entryPath = value.entryRealpath;
  const generation = value.generationToken;
  const activeRequests = value.inflightCount;

  if (!isInteger(processId) || processId <= 0) return null;
  if (typeof launchedAt !== "number" || !Number.isFinite(launchedAt)) return null;
  if (!optionalNonEmptyString(entryPath) || !optionalNonEmptyString(generation)) return null;
  if (activeRequests !== undefined && (!isInteger(activeRequests) || activeRequests < 0)) return null;

  return {
    pid: processId,
    startedAt: launchedAt,
    ...(entryPath === undefined ? {} : { entryRealpath: entryPath }),
    ...(generation === undefined ? {} : { generationToken: generation }),
    ...(activeRequests === undefined ? {} : { inflightCount: activeRequests }),
  };
}

export async function readLocalExecDaemonDiscovery(path: string): Promise<LocalExecDaemonDiscovery | null> {
  let content: string;
  try {
    content = await fs.readFile(path, "utf8");
  } catch (error) {
    if (isFileMissing(error)) return null;
    throw error;
  }

  try {
    return parseDiscovery(JSON.parse(content) as unknown);
  } catch {
    return null;
  }
}
