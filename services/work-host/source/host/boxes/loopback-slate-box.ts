/** The local loopback implementation of the host's box capabilities. */
import type { Context } from "../../packages/context/context.ts";
import { SLATE_BOX_MAX_WINDOWS, type ShellAccessor } from "./box-windows.ts";
import type { BoxEnvironmentUpdate } from "./box-env.ts";
import {
  BOX_TERMINALS_FOLDER,
  DAEMON_READY_TIMEOUT_MS,
  DAEMON_WATCHDOG_INTERVAL_MS,
  DEFAULT_AUTH_TOKEN,
  EXEC_DAEMON_PORT,
  VNC_PORT,
  type BoxEndpoint,
  type LoopbackBoxOptions,
  type LoopbackTelemetry,
} from "./loopback-box-contracts.ts";
import { LoopbackBoxFileAccess } from "./loopback-box-file-access.ts";
import { LoopbackDaemonReadiness, daemonPingReadinessState } from "./loopback-daemon-readiness.ts";
import { LoopbackBoxWindows } from "./loopback-box-windows.ts";

export {
  BOX_TERMINALS_FOLDER,
  DAEMON_READY_TIMEOUT_MS,
  DAEMON_WATCHDOG_INTERVAL_MS,
  DEFAULT_AUTH_TOKEN,
  EXEC_DAEMON_PORT,
  VNC_PORT,
  daemonPingReadinessState,
};
export type {
  BoxEndpoint,
  DaemonPingOutcome,
  DaemonPingReport,
  LoopbackBoxOptions,
  LoopbackOperations,
  LoopbackTelemetry,
  PingResult,
} from "./loopback-box-contracts.ts";

export class LoopbackBox<Accessor extends ShellAccessor = ShellAccessor> {
  readonly host: string;
  readonly authToken: string;
  readonly readyTimeoutMs: number;
  readonly pollIntervalMs: number;
  readonly watchdogIntervalMs: number;
  readonly protectedBoxPaths: readonly string[];

  private readonly readiness: LoopbackDaemonReadiness;
  private readonly windows: LoopbackBoxWindows<Accessor>;
  private readonly fileAccess: LoopbackBoxFileAccess<Accessor>;

  constructor(readonly options: LoopbackBoxOptions<Accessor>) {
    this.host = options.host ?? "127.0.0.1";
    this.authToken = options.authToken ?? DEFAULT_AUTH_TOKEN;
    this.readyTimeoutMs = options.readyTimeoutMs ?? DAEMON_READY_TIMEOUT_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? 500;
    this.watchdogIntervalMs = options.watchdogIntervalMs ?? DAEMON_WATCHDOG_INTERVAL_MS;
    this.protectedBoxPaths = options.protectedBoxPaths ?? [];

    this.readiness = new LoopbackDaemonReadiness({
      operations: options.operations,
      readyTimeoutMs: this.readyTimeoutMs,
      pollIntervalMs: this.pollIntervalMs,
      watchdogIntervalMs: this.watchdogIntervalMs,
      ...(options.telemetry === undefined ? {} : { telemetry: options.telemetry }),
    });
    this.fileAccess = new LoopbackBoxFileAccess({
      protectedPaths: this.protectedBoxPaths,
      operations: options.operations,
      ensureReady: (ctx, agentId) => this.ensureReady(ctx, agentId),
    });
    this.windows = new LoopbackBoxWindows({
      host: this.host,
      authToken: this.authToken,
      operations: options.operations,
      executeWindowCommand: options.operations.executeWindowCommand,
      ensurePrimary: (ctx, agentId) => this.ensureReady(ctx, agentId),
      waitUntilReady: (ctx, endpoint) => this.waitUntilReady(ctx, endpoint),
      protect: accessor => this.protectRemoteAccessor(accessor),
    });
  }

  setTelemetry(telemetry: LoopbackTelemetry): void {
    this.readiness.setTelemetry(telemetry);
  }

  async assertFileReadAllowed(boxPath: string): Promise<void> {
    await this.fileAccess.assertFileReadAllowed(boxPath);
  }

  protectRemoteAccessor(remoteAccessor: Accessor): Accessor {
    return this.fileAccess.protectRemoteAccessor(remoteAccessor);
  }

  describe(): { backend: "loopback" } {
    return { backend: "loopback" };
  }

  getTerminalsFolder(): string {
    return BOX_TERMINALS_FOLDER;
  }

  async isAvailable(): Promise<true> {
    return true;
  }

  primaryEndpoint(): BoxEndpoint {
    return { host: this.host, port: EXEC_DAEMON_PORT, authToken: this.authToken };
  }

  async ensureReady(ctx: Context, _agentId: string): Promise<{ remoteAccessor: Accessor; vncUrl: string; terminalsFolder: string }> {
    const endpoint = this.primaryEndpoint();
    await this.waitUntilReady(ctx, endpoint);
    return {
      remoteAccessor: this.protectRemoteAccessor(this.options.operations.createRemoteAccessor(endpoint)),
      vncUrl: `http://${this.host}:${VNC_PORT}/vnc.html`,
      terminalsFolder: BOX_TERMINALS_FOLDER,
    };
  }

  async applyEnvironment(ctx: Context, update: BoxEnvironmentUpdate): Promise<void> {
    const endpoint = this.primaryEndpoint();
    await this.waitUntilReady(ctx, endpoint);
    const apply = this.options.operations.applyEnvironment;
    if (apply === undefined) throw new Error("loopback environment transport is unavailable");
    await apply(ctx, endpoint, update);
  }

  async loadMcpServers(ctx: Context, configJson: string): Promise<string[]> {
    const endpoint = this.primaryEndpoint();
    await this.waitUntilReady(ctx, endpoint);
    const load = this.options.operations.loadMcpServers;
    if (load === undefined) throw new Error("loopback MCP transport is unavailable");
    return load(ctx, endpoint, configJson);
  }

  async mcpResourceAccessor(ctx: Context): Promise<Accessor> {
    const endpoint = this.primaryEndpoint();
    await this.waitUntilReady(ctx, endpoint);
    return this.options.operations.createRemoteAccessor(endpoint);
  }

  maxWindows(): number {
    return SLATE_BOX_MAX_WINDOWS;
  }

  ensureWindow(ctx: Context, agentId: string, windowIndex: number, options?: { ownerToken?: string }): Promise<{ windowIndex: number; computerUse: Accessor; vncUrl: string }> {
    return this.windows.ensureWindow(ctx, agentId, windowIndex, options);
  }

  releaseWindow(ctx: Context, agentId: string, windowIndex: number): Promise<void> {
    return this.windows.releaseWindow(ctx, agentId, windowIndex);
  }

  async hibernate(_ctx: Context, agentId: string): Promise<void> {
    this.windows.hibernate(agentId);
  }

  async runState(): Promise<"running"> {
    return "running";
  }

  async listBoxes(): Promise<Array<{ agentId: string; running: boolean }>> {
    return [{ agentId: "", running: true }];
  }

  dispose(): Promise<void> {
    return this.readiness.dispose();
  }

  uploadFile(ctx: Context, agentId: string, boxPath: string, data: Uint8Array): Promise<void> {
    return this.fileAccess.upload(ctx, agentId, boxPath, data);
  }

  async downloadFile(_ctx: Context, _agentId: string, boxPath: string): Promise<Buffer> {
    return this.fileAccess.download(boxPath);
  }

  waitUntilReady(ctx: Context, endpoint: BoxEndpoint, timeoutMs = this.readyTimeoutMs): Promise<void> {
    return this.readiness.waitUntilReady(ctx, endpoint, timeoutMs);
  }

  waitUntilReadyUncoordinated(ctx: Context, endpoint: BoxEndpoint, timeoutMs: number): Promise<void> {
    return this.readiness.waitUntilReadyUncoordinated(ctx, endpoint, timeoutMs);
  }

  pollDaemonWatchdog(endpoint: BoxEndpoint): Promise<void> {
    return this.readiness.pollDaemonWatchdog(endpoint);
  }
}
