/** The box's exec daemon as a process: what it starts with and how it stops. */
import path from "node:path";

import { startBoxExecDaemon } from "./server.ts";

export async function runBoxExecDaemonEntrypoint(): Promise<void> {
  const workspaceRoot = path.resolve(process.env.SLATE_BOX_WORKSPACE_ROOT ?? process.cwd());
  const portText = process.env.SLATE_BOX_EXEC_DAEMON_PORT;
  const handle = await startBoxExecDaemon({
    workspaceRoot,
    ...(portText == null ? {} : { port: Number.parseInt(portText, 10) }),
    ...(process.env.SLATE_BOX_TERMINALS_DIRECTORY == null ? {} : { terminalsDirectory: process.env.SLATE_BOX_TERMINALS_DIRECTORY }),
    ...(process.env.SLATE_BOX_EXEC_DAEMON_AUTH_TOKEN == null ? {} : { authToken: process.env.SLATE_BOX_EXEC_DAEMON_AUTH_TOKEN }),
  });
  process.stdout.write(`${JSON.stringify({ event: "box-exec-daemon-ready", url: handle.url, workspaceRoot: handle.workspaceRoot, terminalsDirectory: handle.terminalsDirectory })}\n`);
  const shutdown = async () => {
    await handle.stop();
    process.exitCode = 0;
  };
  process.once("SIGINT", () => { void shutdown(); });
  process.once("SIGTERM", () => { void shutdown(); });
}
