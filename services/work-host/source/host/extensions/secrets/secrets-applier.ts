import type { Context } from "../../../packages/context/context.ts";
import { validateBoxSecrets } from "../../../shared/box-secret-validation.ts";
import { errorLogTag } from "../../../shared/errors/summary.ts";
import { BoxSecretsValidationError, type BoxSecretsApplierOptions, type BoxSecretsStatus } from "./secrets-service-contracts.ts";
import { applyDesiredBoxSecretGenerations } from "./secrets-apply-loop.ts";
import { notifySecretGenerationWaiters, waitForSecretGeneration } from "./secrets-generation-waiters.ts";
import { getBoxSecretsStorePath, readPersistedBoxSecrets, writePersistedBoxSecrets } from "./secrets-store.ts";

/** Persist desired values and reconcile them with a box until the current generation is applied. */
export class BoxSecretsApplier {
  private readonly storePath: string;
  private readonly log: (message: string) => void;
  private desired: Record<string, string> = {};
  private desiredGeneration = 0;
  private appliedGeneration = 0;
  private lastAppliedAtMs: number | null = null;
  private isApplying = false;
  private isStopped = false;
  private readonly stopSignal = new AbortController();
  private appliedWaiters: Array<() => void> = [];

  constructor(private readonly options: BoxSecretsApplierOptions) {
    this.storePath = options.storePath ?? getBoxSecretsStorePath();
    this.log = options.log ?? ((message) => console.info(`[slate-host] ${message}`));
  }

  async setSecrets(context: Context, requested: Record<string, string>): Promise<BoxSecretsStatus> {
    const validationProblem = (this.options.validateSecrets ?? validateBoxSecrets)(requested);
    if (validationProblem != null) throw new BoxSecretsValidationError(validationProblem);

    this.desired = { ...requested };
    this.desiredGeneration += 1;
    const targetGeneration = this.desiredGeneration;
    await writePersistedBoxSecrets(this.storePath, this.desired);
    void this.runApplyLoop(context);
    await this.options.applyDeadline.run((signal) => this.waitForGeneration(targetGeneration, signal))
      .catch((error) => this.log(`box secrets: apply wait ended unconfirmed (${errorLogTag(error)})`));
    return this.getStatus();
  }

  async applyPersisted(context: Context): Promise<void> {
    if (this.desiredGeneration > 0) return;
    const savedSecrets = await readPersistedBoxSecrets(this.storePath);
    if (
      savedSecrets == null ||
      this.desiredGeneration > 0 ||
      (this.options.validateSecrets ?? validateBoxSecrets)(savedSecrets) != null
    ) return;

    this.desired = savedSecrets;
    this.desiredGeneration += 1;
    this.log(`applying ${Object.keys(savedSecrets).length} persisted box secret(s) at startup`);
    await this.runApplyLoop(context);
  }

  getStatus(): BoxSecretsStatus {
    return {
      keys: Object.keys(this.desired).sort(),
      isApplied: this.desiredGeneration > 0 && this.appliedGeneration === this.desiredGeneration,
      lastAppliedAtMs: this.lastAppliedAtMs,
    };
  }

  stop(): void {
    this.isStopped = true;
    this.stopSignal.abort();
    this.notifyApplied();
  }

  private async runApplyLoop(context: Context): Promise<void> {
    if (this.isApplying || this.isStopped) return;
    this.isApplying = true;
    try {
      await applyDesiredBoxSecretGenerations({
        context,
        options: this.options,
        desired: () => this.desired,
        desiredGeneration: () => this.desiredGeneration,
        appliedGeneration: () => this.appliedGeneration,
        isStopped: () => this.isStopped,
        markApplied: (generation, atMs) => {
          this.appliedGeneration = generation;
          this.lastAppliedAtMs = atMs;
        },
        stop: () => { this.isStopped = true; },
        notify: () => this.notifyApplied(),
        log: this.log,
        stopSignal: this.stopSignal.signal,
      });
    } finally {
      this.isApplying = false;
      this.notifyApplied();
    }
  }

  private notifyApplied(): void {
    notifySecretGenerationWaiters(this.appliedWaiters);
  }

  private waitForGeneration(generation: number, signal: AbortSignal): Promise<void> {
    return waitForSecretGeneration({
      generation,
      appliedGeneration: () => this.appliedGeneration,
      isStopped: () => this.isStopped,
      waiters: this.appliedWaiters,
      signal,
    });
  }
}
