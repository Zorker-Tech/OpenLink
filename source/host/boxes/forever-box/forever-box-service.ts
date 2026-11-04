/** Public host service for the computer box kept available across turns. */
import { createContext, type Context } from "../../../packages/context/context.ts";
import { ForeverBoxImageUpdates } from "./forever-box-image-updates.ts";
import { ForeverBoxStatusOverlay } from "./forever-box-status-overlay.ts";
import { HostBox, type BoxStatus } from "./host-box.ts";
import {
  FOREVER_BOX_IMAGE_CHECK_TIMEOUT_MS,
  FOREVER_BOX_IMAGE_WATCH_INTERVAL_MS,
  FOREVER_BOX_MIGRATION_TTL_MS,
  FOREVER_BOX_RECREATE_FLUSH_WAIT_MS,
  FOREVER_BOX_SCREENSHOT_TIMEOUT_MS,
  RECREATE_UNAVAILABLE_MESSAGE,
  type ForeverBoxImageCheckResult,
  type ForeverBoxOptions,
  type ForeverBoxRecreateRequest,
  type ForeverBoxRecreateResult,
} from "./forever-box-service-contracts.ts";

export {
  FOREVER_BOX_IMAGE_CHECK_TIMEOUT_MS,
  FOREVER_BOX_IMAGE_WATCH_INTERVAL_MS,
  FOREVER_BOX_MIGRATION_TTL_MS,
  FOREVER_BOX_RECREATE_FLUSH_WAIT_MS,
  FOREVER_BOX_SCREENSHOT_TIMEOUT_MS,
  RECREATE_UNAVAILABLE_MESSAGE,
};
export type { ForeverBoxOptions };

export class SlateForeverBoxError extends Error {}

export class ForeverBoxService {
  readonly box: HostBox;
  readonly isAutoUpdateEnabled: boolean;

  private readonly ctx: Context;
  private readonly stopController = new AbortController();
  private readonly listeners = new Set<(status: BoxStatus) => void>();
  private readonly unsubscribeBox: () => void;
  private readonly imageUpdates: ForeverBoxImageUpdates;
  private readonly statusOverlay: ForeverBoxStatusOverlay;
  private stopped = false;
  private readonly now: () => number;

  constructor(readonly options: ForeverBoxOptions) {
    this.box = options.box;
    this.ctx = options.ctx ?? createContext().withName("foreverBox");
    this.now = options.now ?? (() => performance.now());
    this.isAutoUpdateEnabled = options.autoUpdateEnabled;
    this.statusOverlay = new ForeverBoxStatusOverlay(options.migrationExpiry);
    this.imageUpdates = new ForeverBoxImageUpdates({
      options,
      box: this.box,
      context: this.ctx,
      signal: this.stopController.signal,
      now: this.now,
      recreate: (agentId, recreateOptions) => this.recreate(agentId, recreateOptions),
      requestRecreate: recreateOptions => this.requestRecreate(recreateOptions),
    });
    this.unsubscribeBox = this.box.subscribe(status => this.emit(this.decorateStatus(status)));
  }

  start(): void {
    this.imageUpdates.start();
  }

  subscribe(listener: (status: BoxStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setBusy(value: boolean): void {
    this.imageUpdates.setBusy(value);
  }

  async getStatus(input: { id: string }): Promise<BoxStatus> {
    const status = await this.box.getStatus(this.ctx, input.id);
    return this.decorateStatus(status);
  }

  async ensure(input: { id: string }): Promise<BoxStatus> {
    const status = await this.box.ensure(this.ctx, input.id);
    void this.imageUpdates.maybeAutoUpdate(input.id, status.imageUpdateAvailable);
    return this.decorateStatus(status);
  }

  reset(input: { id: string }): Promise<BoxStatus> {
    return this.recreate(input.id, { preserveData: false });
  }

  update(input: { id: string; force?: boolean }): Promise<BoxStatus> {
    return this.recreate(input.id, { preserveData: true, ...(input.force === undefined ? {} : { force: input.force }) });
  }

  autoUpdateNow(): Promise<ForeverBoxRecreateResult> {
    return this.imageUpdates.autoUpdateNow();
  }

  refreshImageUpdateAvailable(trigger: string, options?: { coalesce: boolean }): Promise<ForeverBoxImageCheckResult> {
    return this.imageUpdates.refreshImageUpdateAvailable(trigger, options);
  }

  setMigrating(input: { migrating: boolean }): void {
    this.statusOverlay.setMigrating(input.migrating);
  }

  releaseAgent(agentId: string): Promise<void> {
    return this.box.releaseWindow(this.ctx, agentId);
  }

  async captureScreenshot(agentId: string): Promise<Uint8Array | null> {
    if (this.options.captureScreenshot === undefined) return null;
    try {
      return await this.options.screenshotDeadline.run(
        async () => this.options.captureScreenshot!(await this.box.ensureReady(this.ctx, agentId), this.stopController.signal),
        this.stopController.signal,
      );
    } catch {
      return null;
    }
  }

  dispose(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.stopController.abort();
    this.imageUpdates.stop();
    this.statusOverlay.dispose();
    this.unsubscribeBox();
    this.listeners.clear();
  }

  private decorateStatus(status: BoxStatus): BoxStatus {
    return this.statusOverlay.decorate(status);
  }

  private emit(status: BoxStatus): void {
    for (const listener of this.listeners) listener(status);
  }

  private async recreate(agentId: string, options: ForeverBoxRecreateRequest): Promise<BoxStatus> {
    let result: ForeverBoxRecreateResult;
    try {
      result = await this.requestRecreate(options);
    } catch (error) {
      throw new SlateForeverBoxError(RECREATE_UNAVAILABLE_MESSAGE, { cause: error });
    }
    if (!result.started) {
      const operation = options.preserveData ? "update" : "reset";
      const reason = result.reason?.length ? result.reason : "the service declined the recreate";
      throw new SlateForeverBoxError(`Couldn't ${operation} the computer (${reason}). It is unchanged.`);
    }
    this.imageUpdates.markRecreateSucceeded();
    return this.decorateStatus({ agentId, state: "running", vncUrl: null, pull: { percent: 0 } });
  }

  private async requestRecreate(options: ForeverBoxRecreateRequest): Promise<ForeverBoxRecreateResult> {
    try {
      await this.options.recreateFlushWaitDeadline.run(() => this.options.flushPendingUploads(), this.stopController.signal);
    } catch (error) {
      if (this.stopController.signal.aborted) throw error;
      this.options.log(`snapshot upload flush failed before box recreate: ${String(error)}`);
    }
    this.stopController.signal.throwIfAborted();
    return this.options.lifecycleClient.recreateInBox(options);
  }

  private watchForImageUpdate(): Promise<void> {
    return this.imageUpdates.watchForImageUpdate();
  }
}
