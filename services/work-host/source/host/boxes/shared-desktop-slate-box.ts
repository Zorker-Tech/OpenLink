/** The shared-box facade coordinating per-agent windows and persisted ownership. */

import type { Context } from "../../packages/context/context.ts";
import { boxMaxWindows } from "./box-capabilities.ts";
import { BoxCapabilityError, type SharedDesktopOptions, type SharedInnerBox } from "./shared-desktop-contracts.ts";
import { SharedDesktopAssignments, resolveSharedBoxId } from "./shared-desktop-assignments.ts";
import { SharedDesktopCapabilities } from "./shared-desktop-capabilities.ts";
import { SharedDesktopWindowManager } from "./shared-desktop-window-manager.ts";

export {
  ASSIGNMENTS_LOAD_RETRY_INTERVAL_MS,
  ASSIGNMENTS_LOAD_TIMEOUT_MS,
  DEFAULT_SHARED_BOX_ID,
  SHARED_DESKTOP_ASSIGNMENTS_BOX_PATH,
} from "./shared-desktop-contracts.ts";
export type { ParsedAssignments, SharedDesktopOptions, SharedInnerBox } from "./shared-desktop-contracts.ts";
export { BoxCapabilityError } from "./shared-desktop-contracts.ts";
export { parseAssignments, resolveSharedBoxId } from "./shared-desktop-assignments.ts";

export class SharedDesktopBox<Accessor = unknown> {
  readonly sharedBoxId: string;
  readonly maxWindowCount: number;
  readonly persistAssignments: boolean;
  private readonly assignments: SharedDesktopAssignments<Accessor>;
  private readonly capabilities: SharedDesktopCapabilities<Accessor>;
  private readonly windows: SharedDesktopWindowManager<Accessor>;

  constructor(readonly inner: SharedInnerBox<Accessor>, readonly options: SharedDesktopOptions<Accessor> = {}) {
    this.sharedBoxId = resolveSharedBoxId(options.sharedBoxId);
    this.maxWindowCount = Math.max(1, boxMaxWindows(inner));
    this.persistAssignments = options.persistAssignments ?? false;
    this.assignments = new SharedDesktopAssignments(
      this.sharedBoxId,
      this.maxWindowCount,
      this.persistAssignments,
      options,
    );
    this.capabilities = new SharedDesktopCapabilities(inner, this.sharedBoxId, this.assignments);
    this.windows = new SharedDesktopWindowManager(
      inner,
      this.sharedBoxId,
      this.assignments,
      (ctx) => this.queuePersistAssignments(ctx),
      options.gateComputerUse,
    );
  }

  async ensureAssignmentsLoaded(ctx: Context): Promise<void> {
    await this.assignments.load(ctx, this.inner);
  }

  queuePersistAssignments(ctx: Context): void {
    this.assignments.queuePersistence(ctx, this.inner);
  }

  takeFreeForkIndex(agentId: string): number | undefined {
    return this.assignments.takeFreeForkIndex(agentId);
  }

  assignWindow(agentId: string): number | undefined {
    return this.assignments.assignWindow(agentId);
  }

  migrateLegacyPrimarySeat(agentId: string, assigned: number): number {
    return this.assignments.migratePrimarySeat(agentId, assigned, this.inner.ensureWindow != null);
  }

  async ensureReady(ctx: Context, agentId: string) {
    return this.windows.ensureReady(ctx, agentId);
  }

  async hibernate(): Promise<void> {
    await this.capabilities.hibernate();
  }

  async recreateInBox(ctx: Context, options: { preserveData: boolean; force?: boolean }): Promise<{ started: boolean; reason?: string }> {
    return this.capabilities.recreate(ctx, options);
  }

  async applyEnvironment(ctx: Context, update: unknown): Promise<void> {
    await this.capabilities.applyEnvironment(ctx, update);
  }

  async loadMcpServers(ctx: Context, configJson: string): Promise<unknown> {
    return this.capabilities.loadMcpServers(ctx, configJson);
  }

  async mcpResourceAccessor(ctx: Context): Promise<unknown> {
    return this.capabilities.mcpResourceAccessor(ctx);
  }

  async releaseWindow(ctx: Context, agentId: string): Promise<void> {
    await this.windows.release(ctx, agentId);
  }

  getAgentWindowIndex(agentId: string): number | undefined {
    return this.windows.indexOf(agentId);
  }

  getTerminalsFolder(): string | undefined {
    return this.capabilities.terminalsFolder();
  }

  async runState(ctx: Context): Promise<string> {
    return this.capabilities.runState(ctx);
  }

  async isAvailable(): Promise<boolean> {
    return this.capabilities.isAvailable();
  }

  describe(): unknown {
    return this.capabilities.description();
  }

  isPreparing(): boolean {
    return this.capabilities.isPreparing();
  }

  async listBoxes(): Promise<Array<{ agentId: string; running: boolean }>> {
    return this.capabilities.listBoxes();
  }

  async uploadFile(ctx: Context, _agentId: string, path: string, data: Uint8Array): Promise<void> {
    await this.capabilities.uploadFile(ctx, _agentId, path, data);
  }

  async downloadFile(ctx: Context, _agentId: string, path: string): Promise<Uint8Array> {
    return this.capabilities.downloadFile(ctx, _agentId, path);
  }

  async flushPersistence(): Promise<void> {
    await this.assignments.flush();
  }

  async dispose(): Promise<void> {
    await this.flushPersistence();
    await this.capabilities.dispose();
  }
}
