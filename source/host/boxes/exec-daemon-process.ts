/** The box's exec daemon as a child process this host owns.

 * It starts the daemon with the workspace, the terminals directory and the token it was given, waits until the daemon
 * answers an authenticated call before saying it is ready, refuses to start on a port something else is already using,
 * and stops the daemon it started — forcibly if it has to, and never leaving the port bound. */
import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdir } from "node:fs/promises";
import { createConnection } from "node:net";
import path from "node:path";

import { createContext } from "../../packages/context/context.ts";
import { pingBoxClassified } from "./box-remote-accessor.ts";
import type { ErasedProductionBoxGeneratedPorts } from "./production.ts";
import { DEFAULT_AUTH_TOKEN, EXEC_DAEMON_PORT } from "./loopback-slate-box.ts";

export const BOX_DAEMON_ENTRY_FROM_HOST = "../box-exec/main.cjs";
export const BOX_DAEMON_READY_TIMEOUT_MS = 20_000;
export const BOX_DAEMON_STOP_GRACE_MS = 5_000;

export interface HostOwnedBoxExecDaemon {
  readonly pid: number;
  readonly daemonEntryPath: string;
  readonly ready: Promise<void>;
  close(): Promise<void>;
}

export interface BoxExecDaemonLaunchOptions {
  readonly daemonEntryPath: string;
  readonly rpcPorts: ErasedProductionBoxGeneratedPorts;
  readonly bindAddress?: "127.0.0.1";
  readonly bindPort?: number;
  readonly controlToken?: string;
  readonly workspaceDirectory: string;
  readonly terminalDirectory: string;
  readonly processEnvironment?: NodeJS.ProcessEnv;
  readonly nodeExecutable?: string;
  readonly readinessTimeoutMs?: number;
  readonly shutdownTimeoutMs?: number;
  readonly output?: Pick<Console, "log" | "error">;
}

export function resolveBoxDaemonEntryFromHost(hostEntry = process.argv[1]): string {
  if (hostEntry == null || hostEntry.length === 0) {
    throw new Error("cannot resolve box exec-daemon entry without a host process entry");
  }
  return path.resolve(path.dirname(hostEntry), BOX_DAEMON_ENTRY_FROM_HOST);
}

type ChildExit = { readonly code: number | null; readonly signal: NodeJS.Signals | null };

interface SpawnedDaemon {
  readonly child: ChildProcess;
  readonly exited: Promise<ChildExit>;
  readonly pid: number;
}

async function portAcceptsConnections(host: string, port: number): Promise<boolean> {
  return await new Promise(resolve => {
    const socket = createConnection({ host, port });
    const settle = (value: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };
    socket.once("connect", () => settle(true));
    socket.once("error", () => settle(false));
    socket.setTimeout(300, () => settle(false));
  });
}

function childExit(child: ChildProcess): Promise<ChildExit> {
  return new Promise(resolve => child.once("exit", (code, signal) => resolve({ code, signal })));
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function requireFreeDaemonPort(host: string, port: number): Promise<void> {
  if (await portAcceptsConnections(host, port)) {
    throw new Error(`refusing contaminated box exec-daemon startup: ${host}:${port} is already bound`);
  }
}

async function prepareDaemonDirectories(options: BoxExecDaemonLaunchOptions): Promise<void> {
  await access(options.daemonEntryPath);
  await mkdir(options.workspaceDirectory, { recursive: true });
  await mkdir(options.terminalDirectory, { recursive: true });
}

function daemonEnvironment(
  options: BoxExecDaemonLaunchOptions,
  port: number,
  authToken: string
): NodeJS.ProcessEnv {
  return {
    ...(options.processEnvironment ?? process.env),
    SLATE_BOX_EXEC_DAEMON_PORT: String(port),
    SLATE_BOX_EXEC_DAEMON_AUTH_TOKEN: authToken,
    SLATE_BOX_WORKSPACE_ROOT: options.workspaceDirectory,
    SLATE_BOX_TERMINALS_DIRECTORY: options.terminalDirectory,
  };
}

function forwardDaemonOutput(child: ChildProcess, log: Pick<Console, "log" | "error">): void {
  child.stdout?.on("data", chunk => log.log(`[box-exec-daemon] ${String(chunk).trimEnd()}`));
  child.stderr?.on("data", chunk => log.error(`[box-exec-daemon] ${String(chunk).trimEnd()}`));
}

function spawnDaemonProcess(
  options: BoxExecDaemonLaunchOptions,
  port: number,
  authToken: string,
  log: Pick<Console, "log" | "error">
): SpawnedDaemon {
  const child = spawn(options.nodeExecutable ?? process.execPath, [options.daemonEntryPath], {
    cwd: path.dirname(options.daemonEntryPath),
    env: daemonEnvironment(options, port, authToken),
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (child.pid === undefined) throw new Error("box exec-daemon child did not receive a pid");
  const exited = childExit(child);
  forwardDaemonOutput(child, log);
  return { child, exited, pid: child.pid };
}

function daemonReadiness(
  exited: Promise<ChildExit>,
  options: BoxExecDaemonLaunchOptions,
  host: string,
  port: number,
  authToken: string
): Promise<void> {
  return (async () => {
    const deadline = Date.now() + (options.readinessTimeoutMs ?? BOX_DAEMON_READY_TIMEOUT_MS);
    while (Date.now() < deadline) {
      const ping = pingBoxClassified(createContext(), { host, port, authToken }, options.rpcPorts, 500);
      const ended = exited.then(status => {
        throw new Error(`box exec-daemon exited before readiness: ${JSON.stringify(status)}`);
      });
      const result = await Promise.race([ping, ended]);
      if (result.outcome === "ok") return;
      await delay(100);
    }
    throw new Error(`box exec-daemon did not answer authenticated generated Ping at ${host}:${port}`);
  })();
}

async function stopDaemonProcess(
  child: ChildProcess,
  exited: Promise<ChildExit>,
  host: string,
  port: number,
  stopTimeoutMs: number
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const stopped = await Promise.race([
    exited.then(() => true),
    delay(stopTimeoutMs).then(() => false),
  ]);
  if (!stopped) {
    child.kill("SIGKILL");
    await exited;
    throw new Error(`box exec-daemon pid ${child.pid} required forced shutdown`);
  }
  if (await portAcceptsConnections(host, port)) {
    throw new Error(`box exec-daemon shutdown left ${host}:${port} bound`);
  }
}

export async function launchBoxExecDaemon(options: BoxExecDaemonLaunchOptions): Promise<HostOwnedBoxExecDaemon> {
  const host = options.bindAddress ?? "127.0.0.1";
  const port = options.bindPort ?? EXEC_DAEMON_PORT;
  const authToken = options.controlToken ?? DEFAULT_AUTH_TOKEN;
  const log = options.output ?? console;
  await requireFreeDaemonPort(host, port);
  await prepareDaemonDirectories(options);

  const { child, exited, pid } = spawnDaemonProcess(options, port, authToken, log);
  const ready = daemonReadiness(exited, options, host, port, authToken);

  try {
    await ready;
  } catch (error) {
    child.kill("SIGTERM");
    await exited;
    throw error;
  }

  let closed = false;
  return {
    pid,
    daemonEntryPath: options.daemonEntryPath,
    ready,
    async close() {
      if (closed) return;
      closed = true;
      await stopDaemonProcess(child, exited, host, port, options.shutdownTimeoutMs ?? BOX_DAEMON_STOP_GRACE_MS);
    },
  };
}
