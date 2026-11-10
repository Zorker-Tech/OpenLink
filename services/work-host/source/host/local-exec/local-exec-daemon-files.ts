import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { getSlateRootDir } from "../host-paths.ts";
import {
  LOCAL_EXEC_DAEMON_CONNECTION_FILENAME,
  LOCAL_EXEC_DAEMON_CREDENTIAL_FILENAME,
  LOCAL_EXEC_DAEMON_DISCOVERY_FILENAME,
  LOCAL_EXEC_SUPERVISOR_HEARTBEAT_FILENAME,
} from "../../shared/local-exec-daemon.ts";
import { findSystemErrno } from "../../shared/system-errno.ts";
import {
  NO_SUPERVISOR_HEARTBEAT,
  parseLocalExecConnection,
  parseLocalExecCredential,
  parseLocalExecDiscovery,
  parseLocalExecSupervisorHeartbeat,
  type LocalExecConnection,
  type LocalExecCredential,
  type LocalExecDiscovery,
  type LocalExecSupervisorHeartbeat,
} from "./local-exec-daemon-contracts.ts";

function pathUnderSlateRoot(fileName: string, homeDir?: string): string {
  return join(getSlateRootDir(homeDir), fileName);
}

export function getLocalExecDaemonConnectionPath(homeDir?: string): string {
  return pathUnderSlateRoot(LOCAL_EXEC_DAEMON_CONNECTION_FILENAME, homeDir);
}

export function getLocalExecDaemonDiscoveryPath(homeDir?: string): string {
  return pathUnderSlateRoot(LOCAL_EXEC_DAEMON_DISCOVERY_FILENAME, homeDir);
}

export function getLocalExecDaemonCredentialPath(homeDir?: string): string {
  return pathUnderSlateRoot(LOCAL_EXEC_DAEMON_CREDENTIAL_FILENAME, homeDir);
}

export function getLocalExecSupervisorHeartbeatPath(homeDir?: string): string {
  return pathUnderSlateRoot(LOCAL_EXEC_SUPERVISOR_HEARTBEAT_FILENAME, homeDir);
}

/** Write through a same-directory temporary file so readers never see a partial JSON record. */
export async function writeDaemonJsonFile(
  path: string,
  data: unknown,
  options: { pretty?: boolean; mode?: number } = {},
): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true });
  const stagingPath = `${path}.${process.pid}.tmp`;
  const text = JSON.stringify(data, null, options.pretty === true ? 2 : undefined);
  const writeOptions = options.mode == null
    ? "utf8"
    : { encoding: "utf8" as const, mode: options.mode };
  await fs.writeFile(stagingPath, text, writeOptions);
  await fs.rename(stagingPath, path);
}

async function readDaemonJsonFile<Value>(
  path: string,
  validate: (value: unknown) => Value | null,
): Promise<Value | null> {
  let text: string;
  try {
    text = await fs.readFile(path, "utf8");
  } catch (error) {
    if (findSystemErrno(error) === "ENOENT") return null;
    throw error;
  }

  try {
    return validate(JSON.parse(text) as unknown);
  } catch {
    return null;
  }
}

export function writeLocalExecDaemonConnection(
  connection: LocalExecConnection,
  path = getLocalExecDaemonConnectionPath(),
): Promise<void> {
  return writeDaemonJsonFile(path, connection, { mode: 0o600 });
}

export function readLocalExecDaemonConnection(path = getLocalExecDaemonConnectionPath()): Promise<LocalExecConnection | null> {
  return readDaemonJsonFile(path, parseLocalExecConnection);
}

export function readLocalExecDaemonDiscovery(path = getLocalExecDaemonDiscoveryPath()): Promise<LocalExecDiscovery | null> {
  return readDaemonJsonFile(path, parseLocalExecDiscovery);
}

export function readLocalExecDaemonCredential(path = getLocalExecDaemonCredentialPath()): Promise<LocalExecCredential | null> {
  return readDaemonJsonFile(path, parseLocalExecCredential);
}

export async function readLocalExecSupervisorHeartbeat(
  path = getLocalExecSupervisorHeartbeatPath(),
): Promise<LocalExecSupervisorHeartbeat> {
  try {
    return await readDaemonJsonFile(path, parseLocalExecSupervisorHeartbeat) ?? NO_SUPERVISOR_HEARTBEAT;
  } catch {
    return NO_SUPERVISOR_HEARTBEAT;
  }
}
