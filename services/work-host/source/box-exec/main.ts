import path from "node:path";

import { startBoxExecDaemon, type BoxExecDaemonHandle, type BoxExecDaemonOptions } from "./server.ts";

export function boxExecDaemonOptionsFromEnvironment(
  environment: NodeJS.ProcessEnv,
  currentDirectory: string,
): BoxExecDaemonOptions {
  const workspaceRoot = path.resolve(currentDirectory, environment.SLATE_BOX_WORKSPACE_ROOT ?? ".");
  const portText = environment.SLATE_BOX_EXEC_DAEMON_PORT;

  return {
    workspaceRoot,
    ...(portText == null ? {} : { port: Number.parseInt(portText, 10) }),
    ...(environment.SLATE_BOX_TERMINALS_DIRECTORY == null
      ? {}
      : { terminalsDirectory: environment.SLATE_BOX_TERMINALS_DIRECTORY }),
    ...(environment.SLATE_BOX_EXEC_DAEMON_AUTH_TOKEN == null
      ? {}
      : { authToken: environment.SLATE_BOX_EXEC_DAEMON_AUTH_TOKEN }),
  };
}

function readinessRecord(handle: BoxExecDaemonHandle) {
  return {
    event: "box-exec-daemon-ready",
    url: handle.url,
    workspaceRoot: handle.workspaceRoot,
    terminalsDirectory: handle.terminalsDirectory,
  };
}

function installShutdownHandlers(handle: BoxExecDaemonHandle): void {
  const shutdown = async () => {
    await handle.stop();
    process.exitCode = 0;
  };

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => { void shutdown(); });
  }
}

export async function runBoxExecDaemonEntrypoint(): Promise<void> {
  const options = boxExecDaemonOptionsFromEnvironment(process.env, process.cwd());
  const handle = await startBoxExecDaemon(options);

  process.stdout.write(`${JSON.stringify(readinessRecord(handle))}\n`);
  installShutdownHandlers(handle);
}
