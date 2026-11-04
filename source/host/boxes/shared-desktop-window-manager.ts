import type { Context } from "../../packages/context/context.ts";
import { SLATE_BOX_FIRST_FORK_WINDOW_INDEX, SLATE_BOX_PRIMARY_WINDOW_INDEX, isPrimaryWindowIndex } from "../ports/box.ts";
import { mintSlateWindowOwnerToken } from "./box-windows.ts";
import type { SharedDesktopAssignments } from "./shared-desktop-assignments.ts";
import type { SharedDesktopOptions, SharedInnerBox } from "./shared-desktop-contracts.ts";

export class SharedDesktopWindowManager<Accessor> {
  constructor(
    private readonly inner: SharedInnerBox<Accessor>,
    private readonly sharedBoxId: string,
    private readonly assignments: SharedDesktopAssignments<Accessor>,
    private readonly persistAssignments: (ctx: Context) => void,
    private readonly gateComputerUse?: SharedDesktopOptions<Accessor>["gateComputerUse"],
  ) {}

  async ensureReady(ctx: Context, agentId: string) {
    await this.assignments.load(ctx, this.inner);
    const isNewAssignment = !this.assignments.agentWindows.has(agentId);
    const assignedIndex = this.assignments.assignWindow(agentId);
    const primary = await this.inner.ensureReady(ctx, this.sharedBoxId);
    if (assignedIndex == null) return this.gate(primary);

    const activeIndex = this.assignments.migratePrimarySeat(agentId, assignedIndex, this.inner.ensureWindow != null);
    const migrating = activeIndex !== assignedIndex;
    if (isPrimaryWindowIndex(activeIndex)) return primary;

    let tokenWasCreated = false;
    if (!this.assignments.agentWindowTokens.has(agentId)) {
      this.assignments.agentWindowTokens.set(agentId, mintSlateWindowOwnerToken());
      tokenWasCreated = true;
    }
    if (isNewAssignment || tokenWasCreated || migrating) this.persistAssignments(ctx);

    if (this.inner.ensureWindow == null) {
      await this.rollback(ctx, agentId, { isNewAssignment, forkBringupAttempted: false });
      return this.gate(primary);
    }

    try {
      const window = await this.inner.ensureWindow(ctx, this.sharedBoxId, activeIndex, {
        ownerToken: this.assignments.agentWindowTokens.get(agentId)!,
      });
      this.assignments.establishedForks.add(agentId);
      return {
        remoteAccessor: window.computerUse,
        vncUrl: window.vncUrl,
        terminalsFolder: primary.terminalsFolder,
      };
    } catch (error) {
      if (migrating && !this.assignments.establishedForks.has(agentId)) {
        await this.restorePrimarySeat(ctx, agentId, activeIndex);
        return primary;
      }
      await this.rollback(ctx, agentId, { isNewAssignment, forkBringupAttempted: true });
      throw error;
    }
  }

  async release(ctx: Context, agentId: string): Promise<void> {
    const windowIndex = this.assignments.agentWindows.get(agentId);
    this.assignments.agentWindows.delete(agentId);
    this.assignments.agentWindowTokens.delete(agentId);
    this.assignments.establishedForks.delete(agentId);
    if (windowIndex != null) this.persistAssignments(ctx);
    if (windowIndex == null || windowIndex < SLATE_BOX_FIRST_FORK_WINDOW_INDEX) return;

    this.assignments.windowsTearingDown.add(windowIndex);
    try {
      await this.inner.releaseWindow?.(ctx, this.sharedBoxId, windowIndex);
    } finally {
      this.assignments.windowsTearingDown.delete(windowIndex);
    }
  }

  indexOf(agentId: string): number | undefined {
    return this.assignments.agentWindows.get(agentId);
  }

  private async restorePrimarySeat(ctx: Context, agentId: string, forkIndex: number): Promise<void> {
    await this.rollback(ctx, agentId, { isNewAssignment: false, forkBringupAttempted: true });
    if (this.assignments.agentWindows.get(agentId) !== forkIndex) return;
    this.assignments.agentWindows.set(agentId, SLATE_BOX_PRIMARY_WINDOW_INDEX);
    this.assignments.agentWindowTokens.delete(agentId);
    this.persistAssignments(ctx);
  }

  private async rollback(
    ctx: Context,
    agentId: string,
    options: { readonly isNewAssignment: boolean; readonly forkBringupAttempted: boolean },
  ): Promise<void> {
    const windowIndex = this.assignments.agentWindows.get(agentId);
    const isFork = windowIndex != null && windowIndex >= SLATE_BOX_FIRST_FORK_WINDOW_INDEX;
    if (options.forkBringupAttempted && isFork && !this.assignments.establishedForks.has(agentId) && windowIndex != null) {
      try {
        await this.inner.releaseWindow?.(ctx, this.sharedBoxId, windowIndex);
      } catch {
        // A cleanup failure cannot replace the failed fork bring-up result.
      }
    }
    if (options.isNewAssignment) {
      this.assignments.agentWindows.delete(agentId);
      this.assignments.agentWindowTokens.delete(agentId);
      this.persistAssignments(ctx);
    }
  }

  private gate(primary: { remoteAccessor: Accessor; vncUrl: string; terminalsFolder?: string }) {
    return this.gateComputerUse?.(primary) ?? primary;
  }
}
