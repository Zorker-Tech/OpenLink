import type { EventTrigger } from "../../shared/automations.ts";
import { dispatchTriggerEvent } from "./slate-trigger-hub-event-dispatch.ts";
import {
  collectDesiredListeners,
} from "./slate-trigger-hub-listeners.ts";
import { synchronizeTriggerSources } from "./slate-trigger-hub-source-sync.ts";
import type {
  SlateTriggerHubDependencies,
  TriggerSource,
  TriggerSourceStatus,
} from "./slate-trigger-hub-contracts.ts";

export class SlateTriggerHubEngine {
  private readonly sourcesByKind = new Map<string, TriggerSource>();
  private readonly activeKinds = new Set<string>();
  private pollHandle: { dispose(): void } | undefined;
  private serialPasses: Promise<void> = Promise.resolve();
  private pendingPassCount = 0;
  private stopped = false;

  constructor(readonly deps: SlateTriggerHubDependencies) {
    for (const source of deps.sources) this.sourcesByKind.set(source.kind, source);
  }

  start(): void {
    if (this.pollHandle !== undefined) return;
    this.stopped = false;
    this.pollHandle = this.deps.polling.start(async () => {
      try {
        if (this.pendingPassCount === 0) await this.reconcile();
      } catch {
        // Polling is recoverable; a later tick can reconcile again.
      }
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.pollHandle?.dispose();
    this.pollHandle = undefined;
    await this.serialPasses;

    const kindsToStop = [...this.activeKinds];
    this.activeKinds.clear();
    await Promise.all(kindsToStop.map(async (kind) => {
      try {
        await this.sourcesByKind.get(kind)?.stop();
      } catch {
        // Shutdown continues even if a source has already failed.
      }
    }));
  }

  async reconcileNow(): Promise<void> {
    await this.reconcile();
  }

  getSourceStatuses(): Map<string, TriggerSourceStatus> {
    return new Map([...this.sourcesByKind].map(([kind, source]) => [kind, source.getStatus()]));
  }

  desiredListenersByKind(): Promise<Map<string, EventTrigger[]>> {
    return collectDesiredListeners(this.deps);
  }

  acceptEvent(event: Record<string, unknown>): boolean {
    if (this.stopped) return false;
    void this.handleEvent(event);
    return true;
  }

  handleEvent(event: Record<string, unknown>): Promise<void> {
    return dispatchTriggerEvent(this.deps, event, () => this.stopped);
  }

  private reconcile(): Promise<void> {
    this.pendingPassCount += 1;
    const pass = this.serialPasses.then(() => this.reconcilePass());
    this.serialPasses = pass.catch(() => {}).finally(() => { this.pendingPassCount -= 1; });
    return pass;
  }

  private async reconcilePass(): Promise<void> {
    if (this.stopped) return;
    this.deps.onReconcile?.();
    const desired = await this.deps.isReady() ? await this.desiredListenersByKind() : new Map<string, EventTrigger[]>();
    if (this.stopped) return;
    await synchronizeTriggerSources(
      this.sourcesByKind,
      this.activeKinds,
      desired,
      (event) => this.acceptEvent(event),
    );
  }
}
