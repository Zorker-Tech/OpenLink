/** Image freshness checks, background polling and automatic recreate decisions. */
import { DeadlineExceededError } from "../../extensions/scheduling.ts";
import type { Context } from "../../../packages/context/context.ts";
import type { BoxStatus, HostBox } from "./host-box.ts";
import type { ForeverBoxOptions, ForeverBoxRecreateRequest, ForeverBoxRecreateResult, ForeverBoxImageCheckResult } from "./forever-box-service-contracts.ts";

export interface ForeverBoxImageUpdateDependencies {
  options: ForeverBoxOptions;
  box: HostBox;
  context: Context;
  signal: AbortSignal;
  now(): number;
  recreate(agentId: string, options: ForeverBoxRecreateRequest): Promise<BoxStatus>;
  requestRecreate(options: ForeverBoxRecreateRequest): Promise<ForeverBoxRecreateResult>;
}

export class ForeverBoxImageUpdates {
  private busy = false;
  private recreateInProgress = false;
  private failureAlreadyNotified = false;
  private refreshActive = false;
  private stopped = false;
  private pollingHandle: { dispose(): void } | undefined;
  private startupDelay: { elapsed: Promise<void>; dispose(): void } | undefined;

  constructor(private readonly dependencies: ForeverBoxImageUpdateDependencies) {}

  setBusy(value: boolean): void {
    this.busy = value;
  }

  start(): void {
    void this.seedImageAvailability();
    void this.startPolling();
  }

  stop(): void {
    this.stopped = true;
    const delay = this.startupDelay;
    this.startupDelay = undefined;
    delay?.dispose();
    this.pollingHandle?.dispose();
    this.pollingHandle = undefined;
  }

  markRecreateSucceeded(): void {
    this.failureAlreadyNotified = false;
  }

  async autoUpdateNow(): Promise<ForeverBoxRecreateResult> {
    if (!this.dependencies.options.isInBox()) return { started: false, reason: "not-in-box" };
    if (!this.dependencies.options.autoUpdateEnabled) return { started: false, reason: "auto-update-disabled" };
    if (this.busy) return { started: false, reason: "busy" };
    if (this.recreateInProgress) return { started: false, reason: "update-in-flight" };

    this.recreateInProgress = true;
    try {
      const check = await this.refreshImageUpdateAvailable("pre_hibernation", { coalesce: false });
      if (check.outcome === "failed" || check.outcome === "timeout") return { started: false, reason: "staleness-check-failed" };
      if (check.available !== true) return { started: false, reason: "no-update-required" };

      this.dependencies.options.telemetry.reportBoxRecreateDecided({ trigger: "hibernation_auto_update", mode: "pod_recreate", preserved: "true" });
      try {
        const result = await this.dependencies.requestRecreate({ preserveData: true });
        if (result.started) this.failureAlreadyNotified = false;
        return result;
      } catch {
        return { started: false, reason: "recreate-unavailable" };
      }
    } finally {
      this.recreateInProgress = false;
    }
  }

  async refreshImageUpdateAvailable(trigger: string, options: { coalesce: boolean } = { coalesce: true }): Promise<ForeverBoxImageCheckResult> {
    const startedAt = this.dependencies.now();
    if (!this.dependencies.options.isInBox()) {
      this.reportImageCheck({ trigger, outcome: "skipped", durationMs: this.elapsedSince(startedAt), skipReason: "outside_box" });
      return { outcome: "skipped" };
    }
    if (options.coalesce && this.refreshActive) return { outcome: "skipped" };
    if (options.coalesce) this.refreshActive = true;

    try {
      const available = await this.dependencies.options.imageCheckDeadline.run(
        signal => this.dependencies.options.lifecycleClient.fetchImageUpdateAvailable(signal),
        this.dependencies.signal,
      );
      this.dependencies.box.recordImageUpdateAvailable(available);
      const outcome = available === undefined ? "unanswered" : "answered";
      this.reportImageCheck({ trigger, outcome, durationMs: this.elapsedSince(startedAt) });
      return { outcome, ...(available === undefined ? {} : { available }) };
    } catch (error) {
      const outcome = this.dependencies.signal.aborted ? "skipped" : error instanceof DeadlineExceededError ? "timeout" : "failed";
      this.reportImageCheck({ trigger, outcome, durationMs: this.elapsedSince(startedAt) });
      return { outcome };
    } finally {
      if (options.coalesce) this.refreshActive = false;
    }
  }

  async maybeAutoUpdate(agentId: string | undefined, available: boolean | undefined): Promise<void> {
    const settings = this.dependencies.options;
    if (!settings.autoUpdateEnabled || settings.hostBundleAutoUpdateEnabled || available !== true || this.busy || this.recreateInProgress) return;
    this.recreateInProgress = true;
    settings.telemetry.reportBoxRecreateDecided({ trigger: "auto_update", mode: "pod_recreate", preserved: "true" });
    try {
      await this.dependencies.recreate(agentId ?? "", { preserveData: true });
      this.failureAlreadyNotified = false;
    } catch (error) {
      settings.log(`image update failed; computer stays on its current image: ${String(error)}`);
      if (!this.failureAlreadyNotified && agentId != null) {
        this.failureAlreadyNotified = true;
        settings.trays.pushError({
          agentId,
          title: "Computer update failed",
          detail: `Couldn't move Slate's computer to the latest image. It keeps working on its current image. Slate will retry, or you can run "Update Slate's Computer" from Settings > Updates.`,
        });
      }
    } finally {
      this.recreateInProgress = false;
    }
  }

  async watchForImageUpdate(): Promise<void> {
    await this.refreshImageUpdateAvailable("poll");
    const settings = this.dependencies.options;
    if (settings.hostBundleAutoUpdateEnabled || !settings.autoUpdateEnabled || this.busy || this.recreateInProgress) return;
    try {
      if (!await this.dependencies.box.isBoxRunning(this.dependencies.context)) return;
      const agentId = (await this.dependencies.box.listBoxes()).find(item => item.running)?.agentId;
      await this.maybeAutoUpdate(agentId, this.dependencies.box.getImageUpdateAvailable());
    } catch (error) {
      settings.log(`image update watch failed: ${String(error)}`);
    }
  }

  private async seedImageAvailability(): Promise<void> {
    if (!this.dependencies.options.isInBox()) return;
    try {
      await this.dependencies.options.imageSeedRetry.runWithRetry(async () => {
        if ((await this.refreshImageUpdateAvailable("seed")).outcome !== "answered") throw new Error("image state unavailable");
      }, this.dependencies.signal);
    } catch {
      // A later poll will retry the image state check.
    }
  }

  private async startPolling(): Promise<void> {
    const delay = this.dependencies.options.imagePollingStartDelay.schedule(1, this.dependencies.signal);
    this.startupDelay = delay;
    try {
      await delay.elapsed;
    } catch {
      return;
    } finally {
      if (this.startupDelay === delay) {
        this.startupDelay = undefined;
        delay.dispose();
      }
    }
    if (!this.stopped) this.pollingHandle = this.dependencies.options.imagePolling.start(() => this.watchForImageUpdate(), this.dependencies.signal);
  }

  private reportImageCheck(report: Record<string, unknown>): void {
    this.dependencies.options.telemetry.reportBoxImageCheck(report);
  }

  private elapsedSince(startedAt: number): number {
    return Math.max(0, Math.round(this.dependencies.now() - startedAt));
  }

}
