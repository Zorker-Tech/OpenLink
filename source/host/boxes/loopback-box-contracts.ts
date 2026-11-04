/** Values and ports shared by the loopback box and the control plane around it. */
import type { Context } from "../../packages/context/context.ts";
import { BOX_PRIMARY_NOVNC_PORT } from "../../packages/constants/box-endpoints.ts";
import { BOX_TERMINALS_FOLDER } from "../../box-exec/terminal-paths.ts";
import type { BoxEnvironmentUpdate } from "./box-env.ts";
import type { BoxWindowShellCommandExecutor } from "./box-window-shell-contract.ts";
import type { ShellAccessor } from "./box-windows.ts";

export { BOX_TERMINALS_FOLDER } from "../../box-exec/terminal-paths.ts";

export const EXEC_DAEMON_PORT = 1337;
export const VNC_PORT = BOX_PRIMARY_NOVNC_PORT;
export const DEFAULT_AUTH_TOKEN = "local";
export const DAEMON_READY_TIMEOUT_MS = 90_000;
export const DAEMON_WATCHDOG_INTERVAL_MS = 30_000;

export type DaemonPingOutcome = "ok" | "refused" | "timeout" | "dns" | "disconnected" | string;
export interface BoxEndpoint { host: string; port: number; authToken: string; headers?: Record<string, string> }
export interface PingResult { outcome: DaemonPingOutcome; causeSummary?: string }
export interface DaemonPingReport {
  outcome: string;
  attempts: number;
  durationMs: number;
  unreadyDurationMs: number;
  readinessState: string;
  target: string;
  causeSummary?: string;
}
export interface LoopbackTelemetry { reportDaemonPing(report: DaemonPingReport): void }

export interface LoopbackOperations<Accessor extends ShellAccessor = ShellAccessor> {
  ping(ctx: Context, endpoint: BoxEndpoint): Promise<PingResult>;
  createRemoteAccessor(endpoint: BoxEndpoint): Accessor;
  protectRemoteAccessor(accessor: Accessor, assertFileReadAllowed: (path: string) => Promise<void>): Accessor;
  executeWindowCommand: BoxWindowShellCommandExecutor;
  applyEnvironment?(ctx: Context, endpoint: BoxEndpoint, update: BoxEnvironmentUpdate): Promise<void>;
  loadMcpServers?(ctx: Context, endpoint: BoxEndpoint, configJson: string): Promise<string[]>;
  uploadFile?(ctx: Context, accessor: Accessor, path: string, data: Uint8Array): Promise<void>;
  sleep?(ms: number, signal?: AbortSignal): Promise<void>;
  now?(): number;
}

export interface LoopbackBoxOptions<Accessor extends ShellAccessor = ShellAccessor> {
  host?: string;
  authToken?: string;
  telemetry?: LoopbackTelemetry;
  readyTimeoutMs?: number;
  pollIntervalMs?: number;
  watchdogIntervalMs?: number;
  protectedBoxPaths?: readonly string[];
  operations: LoopbackOperations<Accessor>;
}
