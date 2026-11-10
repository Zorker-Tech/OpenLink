import { join } from "node:path";

import {
  LOCAL_EXEC_DAEMON_CONNECTION_FILENAME,
  LOCAL_EXEC_DAEMON_CREDENTIAL_FILENAME,
  LOCAL_EXEC_DAEMON_DISCOVERY_FILENAME,
  LOCAL_EXEC_SUPERVISOR_HEARTBEAT_FILENAME,
} from "../../shared/local-exec-daemon.ts";
import type { LocalExecDaemonPaths } from "./daemon-files-contracts.ts";

export const LOCAL_EXEC_DAEMON_LOG_FILENAME = "local-exec-daemon.log";

export function resolveLocalExecDaemonPaths(dataDir: string): LocalExecDaemonPaths {
  return {
    connectionPath: join(dataDir, LOCAL_EXEC_DAEMON_CONNECTION_FILENAME),
    discoveryPath: join(dataDir, LOCAL_EXEC_DAEMON_DISCOVERY_FILENAME),
    credentialPath: join(dataDir, LOCAL_EXEC_DAEMON_CREDENTIAL_FILENAME),
    logPath: join(dataDir, LOCAL_EXEC_DAEMON_LOG_FILENAME),
    supervisorHeartbeatPath: join(dataDir, LOCAL_EXEC_SUPERVISOR_HEARTBEAT_FILENAME),
  };
}
