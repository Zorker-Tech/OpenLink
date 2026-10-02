/**
 * Slate's own experiment client.
 *
 * The platform's bootstrap endpoint hands back a config that already carries the values for this user — which gates are
 * on, what each experiment and dynamic config resolves to — so this client does no bucketing of its own: it reads that
 * config, answers gate and config questions from it, keeps the platform's bundled value when the config says
 * nothing about a name, and logs
 * exposures (batched, and only when asked) through whatever network the caller allows. A config that cannot be read is
 * not an error: the client answers with nothing rather than failing a start.
 */

import { gzipSync } from "node:zlib";

import { DYNAMIC_CONFIGS, EXPERIMENTS, FLAGS } from "./experiment-config.gen.ts";

export interface SlateExperimentUser extends Record<string, unknown> {
  userID?: string;
}

export const SlateLogEventCompressionMode = { Forced: "forced" } as const;
export type SlateLogEventCompressionMode = (typeof SlateLogEventCompressionMode)[keyof typeof SlateLogEventCompressionMode];

export interface SlateExperimentClientOptions {
  readonly loggingEnabled?: "always" | "never";
  readonly disableStorage?: boolean;
  readonly logEventCompressionMode?: SlateLogEventCompressionMode;
  readonly networkConfig?: {
    readonly api: string;
    readonly networkOverrideFunc?: (url: string, args: RequestInit, fetchImpl?: typeof fetch) => Promise<Response>;
  };
}

export interface SlateExperimentReadOptions {
  readonly disableExposureLog?: boolean;
}

export interface SlateExperimentValue {
  readonly name: string;
  readonly value: Record<string, unknown>;
  readonly groupName: string | null;
}

type ConfigEntry = { value: Record<string, unknown>; groupName: string | null };

function readEntry(raw: unknown): ConfigEntry | undefined {
  if (typeof raw !== "object" || raw == null) return undefined;
  const entry = raw as Record<string, unknown>;
  const value = typeof entry.value === "object" && entry.value != null && !Array.isArray(entry.value) ? (entry.value as Record<string, unknown>) : {};
  const groupName = typeof entry.group_name === "string" && entry.group_name.length > 0 ? entry.group_name : null;
  return { value, groupName };
}

function readEntryMap(raw: unknown): Map<string, ConfigEntry> {
  const map = new Map<string, ConfigEntry>();
  if (typeof raw !== "object" || raw == null || Array.isArray(raw)) return map;
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    const entry = readEntry(value);
    if (entry != null) map.set(name, entry);
  }
  return map;
}

export class SlateExperimentClient {
  private gates = new Map<string, boolean>();
  private configs = new Map<string, ConfigEntry>();
  private experiments = new Map<string, ConfigEntry>();
  private readonly pendingExposures: Record<string, unknown>[] = [];
  private initialized = false;
  private closed = false;

  readonly dataAdapter: { setData: (config: string) => void };

  constructor(
    private readonly clientKey: string,
    private user: SlateExperimentUser,
    private readonly options: SlateExperimentClientOptions = {},
  ) {
    this.dataAdapter = {
      setData: (config: string) => {
        this.applyConfig(config);
      },
    };
  }

  /** Marks the client ready. The config has already been handed over through the data adapter. */
  initializeSync(): void {
    if (this.closed) return;
    this.initialized = true;
  }

  updateUserSync(user: SlateExperimentUser): void {
    if (this.closed) return;
    this.user = user;
  }

  checkGate(name: string, _options?: SlateExperimentReadOptions): boolean {
    if (this.closed) return false;
    return this.gates.get(name) ?? (FLAGS as Record<string, { default?: boolean }>)[name]?.default ?? false;
  }

  getExperiment(name: string, options?: SlateExperimentReadOptions): SlateExperimentValue {
    if (this.closed) return { name, value: {}, groupName: null };
    const entry = this.experiments.get(name) ?? this.configs.get(name);
    const fallback = (EXPERIMENTS as Record<string, { fallbackValues?: Record<string, unknown> }>)[name]?.fallbackValues ?? {};
    const value = { ...fallback, ...(entry?.value ?? {}) };
    const groupName = entry?.groupName ?? null;
    if (options?.disableExposureLog === true || entry == null) return { name, value, groupName };
    this.pendingExposures.push({
      event: "experiment_exposure",
      experiment: name,
      group: groupName,
      userID: typeof this.user.userID === "string" ? this.user.userID : null,
      time: Date.now(),
    });
    return { name, value, groupName };
  }

  getDynamicConfig(name: string, _options?: SlateExperimentReadOptions): { name: string; value: Record<string, unknown> } {
    if (this.closed) return { name, value: {} };
    const fallback = (DYNAMIC_CONFIGS as Record<string, { fallbackValues?: Record<string, unknown> }>)[name]?.fallbackValues ?? {};
    return { name, value: { ...fallback, ...(this.configs.get(name)?.value ?? {}) } };
  }

  /** Sends what was logged since the last flush. A rejection means the network did not take it. */
  async flush(): Promise<void> {
    if (this.closed) return;
    const events = this.pendingExposures.splice(0, this.pendingExposures.length);
    if (events.length === 0) return;
    const body = JSON.stringify({ key: this.clientKey, user: this.user, events });
    const compressed = this.options.logEventCompressionMode === SlateLogEventCompressionMode.Forced;
    const args: RequestInit = {
      method: "POST",
      headers: { "content-type": "application/json", ...(compressed ? { "content-encoding": "gzip" } : {}) },
      body: compressed ? gzipSync(Buffer.from(body, "utf8")) : body,
    };
    const api = this.options.networkConfig?.api ?? "";
    const override = this.options.networkConfig?.networkOverrideFunc;
    const response = override == null ? await fetch(api, args) : await override(api, args);
    if (!response.ok) throw new Error(`experiment log rejected with status ${response.status}`);
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    this.pendingExposures.length = 0;
  }

  private applyConfig(config: string): void {
    this.gates = new Map();
    this.configs = new Map();
    this.experiments = new Map();
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(config) as Record<string, unknown>;
    } catch {
      return;
    }
    if (typeof parsed !== "object" || parsed == null) return;
    const gates = parsed.feature_gates;
    if (typeof gates === "object" && gates != null && !Array.isArray(gates))
      for (const [name, raw] of Object.entries(gates as Record<string, unknown>))
        if (typeof raw === "object" && raw != null) this.gates.set(name, (raw as Record<string, unknown>).value === true);
    this.configs = readEntryMap(parsed.dynamic_configs);
    this.experiments = readEntryMap(parsed.experiments);
    const user = parsed.user;
    if (typeof user === "object" && user != null && !Array.isArray(user) && !this.closed) this.user = user as SlateExperimentUser;
  }
}
