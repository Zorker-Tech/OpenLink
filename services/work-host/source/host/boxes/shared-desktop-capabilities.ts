import type { Context } from "../../packages/context/context.ts";
import {
  boxApplyEnvironment,
  boxDescription,
  boxIsAvailable,
  boxIsPreparing,
  boxLoadMcpServers,
  boxMcpResourceAccessor,
  boxTerminalsFolder,
} from "./box-capabilities.ts";
import type { SharedInnerBox } from "./shared-desktop-contracts.ts";
import { BoxCapabilityError } from "./shared-desktop-contracts.ts";
import type { SharedDesktopAssignments } from "./shared-desktop-assignments.ts";

export class SharedDesktopCapabilities<Accessor> {
  constructor(
    private readonly inner: SharedInnerBox<Accessor>,
    private readonly sharedBoxId: string,
    private readonly assignments: SharedDesktopAssignments<Accessor>,
  ) {}

  async hibernate(): Promise<void> {}

  async recreate(ctx: Context, options: { readonly preserveData: boolean; readonly force?: boolean }): Promise<{ readonly started: boolean; readonly reason?: string }> {
    if (this.inner.recreateInBox == null) {
      throw new BoxCapabilityError("This box backend does not support an in-box recreate.");
    }
    return this.inner.recreateInBox(ctx, options);
  }

  async applyEnvironment(ctx: Context, update: unknown): Promise<void> {
    await boxApplyEnvironment(this.inner, ctx, update);
  }

  async loadMcpServers(ctx: Context, configJson: string): Promise<unknown> {
    return boxLoadMcpServers(this.inner, ctx, configJson);
  }

  async mcpResourceAccessor(ctx: Context): Promise<unknown> {
    return boxMcpResourceAccessor(this.inner, ctx);
  }

  terminalsFolder(): string | undefined {
    return boxTerminalsFolder(this.inner);
  }

  async runState(ctx: Context): Promise<string> {
    return this.inner.runState(ctx, this.sharedBoxId);
  }

  async isAvailable(): Promise<boolean> {
    return boxIsAvailable(this.inner);
  }

  description(): unknown {
    return boxDescription(this.inner);
  }

  isPreparing(): boolean {
    return boxIsPreparing(this.inner, this.sharedBoxId);
  }

  async listBoxes(): Promise<Array<{ agentId: string; running: boolean }>> {
    const sharedBoxRunning = (await this.inner.listBoxes()).some((box) => box.running);
    return [...this.assignments.agentWindows.keys()].map((agentId) => ({ agentId, running: sharedBoxRunning }));
  }

  async uploadFile(ctx: Context, _agentId: string, path: string, data: Uint8Array): Promise<void> {
    await this.inner.uploadFile(ctx, this.sharedBoxId, path, data);
  }

  async downloadFile(ctx: Context, _agentId: string, path: string): Promise<Uint8Array> {
    return this.inner.downloadFile(ctx, this.sharedBoxId, path);
  }

  async dispose(): Promise<void> {
    await this.inner.dispose?.();
  }
}
