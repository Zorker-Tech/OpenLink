import { FLAGS, type FeatureFlagName } from "./experiment-config.gen.ts";

export interface TimedFeatureFlagOverride {
  readonly value: boolean;
  readonly expiresAtMs: number;
}

export function isFlagName(name: string): name is FeatureFlagName {
  return Object.hasOwn(FLAGS, name);
}

export class FeatureFlagOverrideLedger {
  private readonly entriesByName = new Map<FeatureFlagName, TimedFeatureFlagOverride>();

  get size(): number {
    return this.entriesByName.size;
  }

  hydrate(entries: ReadonlyMap<FeatureFlagName, TimedFeatureFlagOverride>): void {
    for (const [name, entry] of entries) this.entriesByName.set(name, entry);
  }

  read(name: FeatureFlagName, now: number): boolean | undefined {
    const entry = this.entriesByName.get(name);
    if (entry == null) return undefined;
    if (entry.expiresAtMs <= now) {
      this.entriesByName.delete(name);
      return undefined;
    }
    return entry.value;
  }

  active(now: number): Map<FeatureFlagName, boolean> {
    const visible = new Map<FeatureFlagName, boolean>();
    for (const [name, entry] of this.entriesByName) {
      if (entry.expiresAtMs > now) visible.set(name, entry.value);
    }
    return visible;
  }

  snapshot(): Record<string, TimedFeatureFlagOverride> {
    const serialized: Record<string, TimedFeatureFlagOverride> = {};
    for (const [name, entry] of this.entriesByName) serialized[name] = entry;
    return serialized;
  }

  set(name: string, value: boolean, now: number, ttlMs: number): boolean {
    if (!isFlagName(name)) return false;
    this.entriesByName.set(name, { value, expiresAtMs: now + ttlMs });
    return true;
  }

  clear(name: FeatureFlagName): boolean {
    return this.entriesByName.delete(name);
  }

  clearAll(): void {
    this.entriesByName.clear();
  }

  setAllToBundledDefaults(now: number, ttlMs: number): void {
    const expiresAtMs = now + ttlMs;
    for (const name of Object.keys(FLAGS)) {
      if (isFlagName(name)) this.entriesByName.set(name, { value: FLAGS[name]?.default ?? false, expiresAtMs });
    }
  }

  replaceAll(overrides: Readonly<Record<string, unknown>>, now: number, ttlMs: number): void {
    this.entriesByName.clear();
    const expiresAtMs = now + ttlMs;
    for (const [name, value] of Object.entries(overrides)) {
      if (typeof value === "boolean" && isFlagName(name)) this.entriesByName.set(name, { value, expiresAtMs });
    }
  }
}
