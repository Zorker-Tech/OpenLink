/** The box the host keeps for itself, with its public capability and status boundary. */
import type { Context } from "../../../packages/context/context.ts";
import {
  boxApplyEnvironment,
  boxDescription,
  boxIsAvailable,
  boxIsPreparing,
  boxLoadMcpServers,
  boxMaxWindows,
  boxMcpResourceAccessor,
  boxTerminalsFolder,
} from "../box-capabilities.ts";
import type { BoxConnection, BoxStatus, HostBoxInner } from "./host-box-contracts.ts";
import { HostBoxStatusState } from "./host-box-status-state.ts";

export type { BoxConnection, BoxStatus, HostBoxInner } from "./host-box-contracts.ts";

export class BoxCapabilityError extends Error {}
export const RUN_STATE_PROBE_AGENT_ID = "";

export class HostBox {
  readonly vncUrls: Map<string, string>;
  readonly forkVncUrls: Map<string, Map<number, string>>;
  private readonly status: HostBoxStatusState;

  constructor(readonly inner: HostBoxInner) {
    this.status = new HostBoxStatusState();
    this.vncUrls = this.status.vncUrls;
    this.forkVncUrls = this.status.forkVncUrls;
  }

  subscribe(listener: (status: BoxStatus) => void): () => void {
    return this.status.subscribe(listener);
  }

  private get capabilityPorts(): HostBoxInner {
    return this.inner;
  }

  buildWindows(agentId: string): Array<{ windowIndex: number; vncUrl: string }> | undefined {
    return this.status.buildWindows(agentId);
  }

  recordConnection(agentId: string, connection: BoxConnection): void {
    this.status.recordConnection(agentId, connection);
  }

  recordImageUpdateAvailable(value: boolean | undefined): void {
    this.status.recordImageUpdateAvailable(value);
  }

  runningStatus(agentId: string, vncUrl: string): BoxStatus {
    return this.status.runningStatus(agentId, vncUrl);
  }

  async ensureReady(ctx: Context, agentId: string): Promise<BoxConnection> {
    const connection = await this.capabilityPorts.ensureReady(ctx, agentId);
    this.recordConnection(agentId, connection);
    this.status.publishStatus(this.status.runningStatus(agentId, connection.vncUrl));
    return connection;
  }

  async hibernate(): Promise<void> {}

  runState(ctx: Context, agentId: string): Promise<string> {
    return this.capabilityPorts.runState(ctx, agentId);
  }

  describe(): unknown {
    return boxDescription(this.capabilityPorts);
  }

  isAvailable(): Promise<boolean> {
    return boxIsAvailable(this.capabilityPorts);
  }

  isPreparing(agentId: string): boolean {
    return boxIsPreparing(this.capabilityPorts, agentId);
  }

  getTerminalsFolder(): string | undefined {
    return boxTerminalsFolder(this.capabilityPorts);
  }

  listBoxes() {
    return this.capabilityPorts.listBoxes();
  }

  maxWindows(): number {
    return boxMaxWindows(this.capabilityPorts);
  }

  async ensureWindow(
    ctx: Context,
    agentId: string,
    windowIndex: number,
    options?: unknown,
  ): Promise<{ windowIndex: number; vncUrl: string }> {
    if (this.capabilityPorts.ensureWindow == null) throw new BoxCapabilityError("This box does not support multiple desktop windows.");
    if (!this.status.hasMainWindow(agentId)) await this.ensureReady(ctx, agentId);

    const window = await this.capabilityPorts.ensureWindow(ctx, agentId, windowIndex, options);
    if (window.windowIndex === 0) {
      this.status.setMainWindowUrl(agentId, window.vncUrl);
    } else {
      this.status.recordForkWindow(agentId, window.windowIndex, window.vncUrl);
    }
    this.status.publishStatus(this.status.runningStatus(agentId, this.status.mainWindowUrl(agentId) ?? window.vncUrl));
    return window;
  }

  async releaseWindow(ctx: Context, agentId: string): Promise<void> {
    const generation = this.status.connectionGeneration(agentId);
    try {
      await this.capabilityPorts.releaseWindow?.(ctx, agentId);
    } catch {
      // Releasing a window is best effort; local ownership still needs to be retired.
    }
    this.status.finishRelease(agentId, generation);
  }

  async applyEnvironment(ctx: Context, update: unknown): Promise<void> {
    await boxApplyEnvironment(this.capabilityPorts, ctx, update);
  }

  async loadMcpServers(ctx: Context, configJson: string): Promise<unknown> {
    return await boxLoadMcpServers(this.capabilityPorts, ctx, configJson);
  }

  async mcpResourceAccessor(ctx: Context): Promise<unknown> {
    return await boxMcpResourceAccessor(this.capabilityPorts, ctx);
  }

  uploadFile(ctx: Context, agentId: string, path: string, data: Uint8Array): Promise<void> {
    return this.capabilityPorts.uploadFile(ctx, agentId, path, data);
  }

  downloadFile(ctx: Context, agentId: string, path: string): Promise<Uint8Array> {
    return this.capabilityPorts.downloadFile(ctx, agentId, path);
  }

  async getStatus(ctx: Context, agentId: string): Promise<BoxStatus> {
    const state = await this.capabilityPorts.runState(ctx, agentId);
    const imageUpdateAvailable = this.status.getImageUpdateAvailable();
    if (state !== "running") {
      this.status.clearWindowUrls(agentId);
      return this.status.report({
        agentId,
        state,
        vncUrl: null,
        ...(imageUpdateAvailable === undefined ? {} : { imageUpdateAvailable }),
      });
    }

    const cachedUrl = this.status.mainWindowUrl(agentId);
    if (cachedUrl != null) return this.status.report(this.runningStatus(agentId, cachedUrl));
    return this.status.report({
      agentId,
      state: "absent",
      vncUrl: null,
      ...(imageUpdateAvailable === undefined ? {} : { imageUpdateAvailable }),
    });
  }

  getImageUpdateAvailable(): boolean | undefined {
    return this.status.getImageUpdateAvailable();
  }

  async isBoxRunning(ctx: Context): Promise<boolean> {
    return await this.capabilityPorts.runState(ctx, RUN_STATE_PROBE_AGENT_ID) === "running";
  }

  async ensure(ctx: Context, agentId: string): Promise<BoxStatus> {
    const connection = await this.ensureReady(ctx, agentId);
    return this.status.runningStatus(agentId, connection.vncUrl);
  }

  async recreateInBox(ctx: Context, options: { preserveData: boolean; force?: boolean }): Promise<{ started: boolean; reason?: string }> {
    if (this.capabilityPorts.recreateInBox == null) throw new BoxCapabilityError("This computer can't be recreated from inside the box.");
    return this.capabilityPorts.recreateInBox(ctx, options);
  }

  getAgentWindowIndex(agentId: string): number | undefined {
    return this.capabilityPorts.getAgentWindowIndex?.(agentId);
  }
}
