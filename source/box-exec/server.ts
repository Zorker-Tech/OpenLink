/** The box's own exec daemon: what runs commands inside the box and answers the host's calls.

 * It serves the box's controlElement and exec operations over the daemon's own connection, behind the token it was started
 * with: capabilities and environment, the MCP servers it may load, a command that streams as it runs, a runCommand that
 * keeps running after the call, and the terminal file a background runCommand writes into. Every path a caller names is
 * mapped into the workspace the daemon was given and checked against it, so a call can act on the box and on nothing
 * else. */
import { createServer, type Server } from "node:http";
import { mkdir, realpath, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { BOX_TERMINAL_VIRTUAL_PREFIX } from "./terminal-paths.ts";
import { BoxExecRuntime } from "./runtime.ts";
import { createBoxExecProtocolHandler } from "../adapters/interop/agent/box-exec-daemon-protocol-adapter.ts";
import { handleSlateBoxControlHttp } from "./control-http.ts";
import { handleSlateBoxExecHttp } from "./exec-http.ts";

export const BOX_EXEC_DAEMON_HOST = "127.0.0.1";
export const BOX_EXEC_DAEMON_PORT = 1337;
export const BOX_EXEC_DAEMON_AUTH_TOKEN = "local";
export { BOX_TERMINAL_VIRTUAL_PREFIX } from "./terminal-paths.ts";

export interface BoxExecDaemonOptions {
  readonly host?: string;
  readonly port?: number;
  readonly authToken?: string;
  readonly workspaceRoot: string;
  readonly terminalsDirectory?: string;
  readonly environment?: NodeJS.ProcessEnv;
}

export interface BoxExecDaemonHandle {
  readonly host: string;
  readonly port: number;
  readonly url: string;
  readonly workspaceRoot: string;
  readonly terminalsDirectory: string;
  readonly ready: Promise<void>;
  isReady(): boolean;
  stop(): Promise<void>;
}

function closeServer(daemonServer: Server): Promise<void> {
  return new Promise((resolve, reject) => daemonServer.close(error => error == null ? resolve() : reject(error)));
}

export async function startBoxExecDaemon(settings: BoxExecDaemonOptions): Promise<BoxExecDaemonHandle> {
  const bindHost = settings.host ?? BOX_EXEC_DAEMON_HOST;
  const bindPort = settings.port ?? BOX_EXEC_DAEMON_PORT;
  const expectedToken = settings.authToken ?? BOX_EXEC_DAEMON_AUTH_TOKEN;
  const workspaceRootInput = path.resolve(settings.workspaceRoot);
  const terminalsDirectoryInput = path.resolve(settings.terminalsDirectory ?? path.join(tmpdir(), "slate-box-terminals"));
  await mkdir(workspaceRootInput, { recursive: true });
  await mkdir(terminalsDirectoryInput, { recursive: true });
  const [workspaceRoot, terminalsDirectory] = await Promise.all([
    realpath(workspaceRootInput),
    realpath(terminalsDirectoryInput),
  ]);
  await stat(workspaceRoot).then(info => {
    if (!info.isDirectory()) throw new Error(`workspaceRoot is not a directory: ${workspaceRoot}`);
  });
  const execRuntime = new BoxExecRuntime(workspaceRoot, terminalsDirectory, settings.environment ?? process.env);
  const connectHandler = createBoxExecProtocolHandler(execRuntime);
  let daemonReady = false;
  const daemonServer = createServer((call, reply) => {
    if (call.headers.authorization !== `Bearer ${expectedToken}`) {
      reply.writeHead(401, { "content-type": "text/plain; charset=utf-8" });
      reply.end("Unauthorized");
      return;
    }
    void handleSlateBoxControlHttp(execRuntime, call, reply)
      .then(async (handled) => handled || await handleSlateBoxExecHttp(execRuntime, call, reply))
      .then((handled) => {
        if (!handled) connectHandler(call, reply);
      }, (error: unknown) => {
        reply.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
        reply.end(error instanceof Error ? error.message : String(error));
      });
  });
  const ready = new Promise<void>((resolve, reject) => {
    daemonServer.once("error", reject);
    daemonServer.listen(bindPort, bindHost, () => { daemonServer.off("error", reject); daemonReady = true; resolve(); });
  });
  await ready;
  const bindAddress = daemonServer.address();
  if (bindAddress == null || typeof bindAddress === "string") throw new Error("Box exec daemon did not expose a TCP address");
  let isStopped = false;
  return {
    host: bindHost,
    port: bindAddress.port,
    url: `http://${bindHost}:${bindAddress.port}`,
    workspaceRoot,
    terminalsDirectory,
    ready,
    isReady: () => daemonReady && !isStopped,
    async stop() {
      if (isStopped) return;
      isStopped = true;
      daemonReady = false;
      await execRuntime.stop();
      await closeServer(daemonServer);
    },
  };
}
