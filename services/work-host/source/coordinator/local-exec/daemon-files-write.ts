import { promises as fs } from "node:fs";
import { dirname } from "node:path";

import {
  LOCAL_EXEC_DAEMON_CONNECTION_FILENAME,
  LOCAL_EXEC_DAEMON_CREDENTIAL_FILENAME,
} from "../../shared/local-exec-daemon.ts";

export async function writeSecretJsonFile(path: string, data: unknown): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await fs.writeFile(temporaryPath, JSON.stringify(data), { encoding: "utf8", mode: 0o600 });
  await fs.rename(temporaryPath, path);
}

export function writeLocalExecDaemonConnection(connection: unknown, path: string): Promise<void> {
  return writeSecretJsonFile(path, connection);
}

export function writeLocalExecDaemonCredential(credential: unknown, path: string): Promise<void> {
  return writeSecretJsonFile(path, credential);
}

export function writeLocalExecSupervisorHeartbeat(path: string): Promise<void> {
  return writeSecretJsonFile(path, { pid: process.pid, at: Date.now() });
}

export async function removeLocalExecDaemonFile(path: string): Promise<void> {
  try {
    await fs.unlink(path);
  } catch (error) {
    if (!isMissingPath(error)) throw error;
  }
}

function isMissingPath(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
