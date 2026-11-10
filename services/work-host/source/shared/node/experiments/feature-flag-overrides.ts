import { join } from "node:path";
import { errorLogTag } from "../../errors/summary.ts";
import { reportExperimentsDiagnostic } from "./experiments-diagnostics.ts";
import type { FeatureFlagName } from "./experiment-config.gen.ts";
import { FeatureFlagOverrideLedger, isFlagName } from "./feature-flag-override-state.ts";
import { readFeatureFlagOverrideSnapshot, writeFeatureFlagOverrideSnapshot } from "./feature-flag-override-storage.ts";

export { isFlagName } from "./feature-flag-override-state.ts";

export const FEATURE_FLAG_OVERRIDES_FILENAME = "slate-feature-flag-overrides.json";
export const FEATURE_FLAG_OVERRIDE_TTL_MS = 24 * 60 * 60 * 1_000;

export class SlateFeatureFlagOverrideStore {
  private readonly ledger = new FeatureFlagOverrideLedger();

  constructor(
    private readonly getCacheDir: () => string,
    private readonly now: () => number = Date.now,
  ) {}

  getOverridesPath(): string {
    return join(this.getCacheDir(), FEATURE_FLAG_OVERRIDES_FILENAME);
  }

  hydrateFromDisk(): void {
    try {
      const snapshot = readFeatureFlagOverrideSnapshot(this.getOverridesPath(), this.now());
      if (snapshot !== undefined) this.ledger.hydrate(snapshot);
    } catch (error) {
      reportExperimentsDiagnostic({ kind: "overrides_load_failed", errorClass: errorLogTag(error) });
    }
  }

  async persist(): Promise<void> {
    try {
      await writeFeatureFlagOverrideSnapshot(this.getOverridesPath(), this.ledger.snapshot());
    } catch (error) {
      reportExperimentsDiagnostic({ kind: "overrides_persist_failed", errorClass: errorLogTag(error) });
    }
  }

  read(name: FeatureFlagName): boolean | undefined {
    return this.ledger.read(name, this.now());
  }

  activeOverrides(): Map<FeatureFlagName, boolean> {
    return this.ledger.active(this.now());
  }

  activeRecord(): Partial<Record<FeatureFlagName, boolean>> {
    return Object.fromEntries(this.activeOverrides()) as Partial<Record<FeatureFlagName, boolean>>;
  }

  get size(): number {
    return this.ledger.size;
  }

  set(name: string, value: boolean): boolean {
    return this.ledger.set(name, value, this.now(), FEATURE_FLAG_OVERRIDE_TTL_MS);
  }

  clear(name: FeatureFlagName): boolean {
    return this.ledger.clear(name);
  }

  clearAll(): void {
    this.ledger.clearAll();
  }

  setAllToBundledDefaults(): void {
    this.ledger.setAllToBundledDefaults(this.now(), FEATURE_FLAG_OVERRIDE_TTL_MS);
  }

  replaceAll(overrides: Readonly<Record<string, boolean>>): void {
    this.ledger.replaceAll(overrides, this.now(), FEATURE_FLAG_OVERRIDE_TTL_MS);
  }
}
