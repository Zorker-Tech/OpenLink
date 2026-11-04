/**
 * Coordinates the host's experiment answers across bundled defaults, cached data, live refreshes and local overrides.
 * Snapshot assembly and the small polling/environment rules live in their own modules so this class owns lifecycle.
 */

import {
  SlateExperimentClient,
  SlateLogEventCompressionMode,
  type SlateExperimentUser,
} from "./slate-experiment-client.ts";
import {
  createDeadlinePolicy,
  createPollingPolicy,
  DeadlineExceededError,
  realClock,
  type PollingPolicy,
} from "../../../host/extensions/scheduling.ts";
import { errorLogTag } from "../../errors/summary.ts";
import { getConfiguredBackendUrl } from "../slate-token.ts";
import {
  DYNAMIC_CONFIGS,
  EXPERIMENTS,
  FLAGS,
  type DynamicConfigName,
  type ExperimentName,
  type FeatureFlagName,
} from "./experiment-config.gen.ts";
import { SlateFeatureFlagOverrideStore, isFlagName } from "./feature-flag-overrides.ts";
import { MutableGateProperty } from "./gate-property.ts";
import { reportExperimentsDiagnostic } from "./experiments-diagnostics.ts";
import {
  SLATE_AUTOMATIONS_MODEL_CONFIG_NAME,
  SLATE_DEFAULT_MODEL_CONFIG_NAME,
  SLATE_MODEL_FILTER_CONFIG_NAME,
  resolveSlateDefaultModelConfig,
  type ModelConfigRejection,
} from "./slate-model-config.ts";
import {
  SLATE_MODEL_EXPERIMENT_NAME,
  readSlateModelExperimentEnvOverride,
  resolveSlateModelExperimentState,
} from "./slate-model-experiment.ts";
import {
  SLATE_EXPERIMENT_CLIENT_KEY,
  SLATE_EXPERIMENT_LOG_ENDPOINT,
  extractExperimentUser,
  fetchExperimentBootstrap,
  readExperimentBootstrapUserId,
  experimentNetworkOverride,
} from "../../../adapters/interop/experiments/experiment-bootstrap-adapter.ts";
import { loadCachedBootstrap, saveCachedBootstrap } from "./slate-experiment-bootstrap.ts";
import {
  BOOTSTRAP_TIMEOUT_MS,
  GATE_READY_TIMEOUT_MS,
  envGateOverride,
  jitteredSlateExperimentPollIntervalMs,
} from "./slate-experiment-policies.ts";
import type { ExperimentSnapshot, RefreshTrigger } from "./slate-experiment-contracts.ts";
import { createExperimentSnapshot } from "./slate-experiment-snapshot.ts";

const CLIENT_READ_OPTIONS = { disableExposureLog: true } as const;

interface SlateExperimentServiceOptions {
  readonly getAccessToken: (options: { backendUrl: string }) => Promise<string>;
  readonly getMachineId: () => Promise<string>;
  readonly getCacheDir: () => string;
  readonly isDevBuild?: boolean;
  readonly bootstrapTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly env?: NodeJS.ProcessEnv;
}

export class SlateExperimentService {
  private client: SlateExperimentClient | null = null;
  private initialized = false;
  private refreshing = false;
  private queuedTrigger: RefreshTrigger | null = null;
  private disposed = false;
  private pollHandle: ReturnType<PollingPolicy["start"]> | undefined;
  private startupTickConsumed = false;
  private activeRefresh: Promise<void> | null = null;

  private authenticatedBootstrap = false;
  private liveBootstrap = false;
  private authRevision = 0;
  private snapshot: ExperimentSnapshot;

  private readonly listeners = new Set<(snapshot: ExperimentSnapshot) => void>();
  private readonly gateProperties = new Map<FeatureFlagName, MutableGateProperty>();
  private readonly overrideStore: SlateFeatureFlagOverrideStore;
  private insiderUser = false;
  private readonly loggedConfigRejections = new Map<string, Set<ModelConfigRejection>>();
  private rateLimitedUntil: number | undefined;
  private flagsFetchedAt: number | undefined;

  private readonly bootstrapDeadline;
  private readonly refreshPoll;
  private hydratedUserId: string | null = null;
  private hydratedUserWaiter: Promise<boolean> | null = null;
  private resolveHydratedUserWaiter: ((value: boolean) => void) | null = null;

  constructor(private readonly options: SlateExperimentServiceOptions) {
    this.bootstrapDeadline = createDeadlinePolicy(realClock, {
      name: "slate-experiments-bootstrap",
      timeoutMs: options.bootstrapTimeoutMs ?? BOOTSTRAP_TIMEOUT_MS,
    });
    this.refreshPoll = createPollingPolicy(realClock, {
      name: "slate-experiments-refresh-poll",
      intervalMs: options.pollIntervalMs ?? jitteredSlateExperimentPollIntervalMs(options.isDevBuild === true),
    });
    this.overrideStore = new SlateFeatureFlagOverrideStore(options.getCacheDir);
    if (this.canUseFeatureFlagOverrides()) this.overrideStore.hydrateFromDisk();
    this.snapshot = this.buildSnapshot();
  }

  start(): void {
    const cached = loadCachedBootstrap(this.options.getCacheDir());
    if (cached != null) {
      try {
        this.hydrate(cached.config);
        this.flagsFetchedAt = cached.fetchedAtMs;
      } catch (error) {
        reportExperimentsDiagnostic({ kind: "bootstrap_cache_hydrate_failed", errorClass: errorLogTag(error) });
      }
    }

    this.broadcastSnapshot();
    this.pollHandle = this.refreshPoll.start(() => {
      const trigger = this.startupTickConsumed ? "poll" : "startup";
      this.startupTickConsumed = true;
      return this.refresh(trigger);
    });
  }

  handleAuthChange(): void {
    this.authRevision += 1;
    void this.refresh("auth_change");
  }

  async refreshNow(): Promise<void> {
    await this.refresh("manual");
  }

  subscribe(listener: (snapshot: ExperimentSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getSnapshot(): ExperimentSnapshot {
    return this.snapshot;
  }

  getFeatureGateProperty(name: FeatureFlagName): MutableGateProperty {
    let property = this.gateProperties.get(name);
    if (property == null) {
      property = new MutableGateProperty(this.checkFeatureGate(name));
      this.gateProperties.set(name, property);
    }
    return property;
  }

  pinGateOnAuthenticatedBootstrap(name: FeatureFlagName, pin: (value: boolean) => void): void {
    if (this.authenticatedBootstrap) {
      pin(this.checkFeatureGate(name));
      return;
    }

    const unsubscribe = this.subscribe(() => {
      if (!this.authenticatedBootstrap) return;
      unsubscribe();
      pin(this.checkFeatureGate(name));
    });
  }

  checkFeatureGate(name: FeatureFlagName): boolean {
    const local = this.overrideStore.read(name);
    if (local != null) return local;

    const environment = this.canUseFeatureFlagOverrides() ? envGateOverride(name, this.options.env) : undefined;
    if (environment != null) return environment;
    if (this.client == null) return FLAGS[name]?.default ?? false;

    try {
      return this.client.checkGate(name, CLIENT_READ_OPTIONS);
    } catch {
      return FLAGS[name]?.default ?? false;
    }
  }

  hasAuthenticatedBootstrap(): boolean {
    return this.authenticatedBootstrap;
  }

  hasLiveBootstrap(): boolean {
    return this.liveBootstrap;
  }

  getFlagsAgeMs(): number | undefined {
    return this.flagsFetchedAt == null ? undefined : Math.max(0, Date.now() - this.flagsFetchedAt);
  }

  canUseFeatureFlagOverrides(): boolean {
    return this.options.isDevBuild === true || this.insiderUser;
  }

  setIsInsiderUser(value: boolean): void {
    if (this.insiderUser === value) return;
    const wasAllowed = this.canUseFeatureFlagOverrides();
    this.insiderUser = value;
    const isAllowed = this.canUseFeatureFlagOverrides();
    if (wasAllowed === isAllowed) return;

    if (isAllowed) this.overrideStore.hydrateFromDisk();
    else this.overrideStore.clearAll();
    this.broadcastSnapshot();
  }

  getFeatureFlagOverrides(): Map<FeatureFlagName, boolean> {
    return this.overrideStore.activeOverrides();
  }

  setFeatureFlagOverride(name: string, value: boolean): void {
    if (this.canUseFeatureFlagOverrides() && this.overrideStore.set(name, value)) this.persistOverridesAndNotify();
  }

  clearFeatureFlagOverride(name: FeatureFlagName): void {
    if (this.canUseFeatureFlagOverrides() && this.overrideStore.clear(name)) this.persistOverridesAndNotify();
  }

  clearAllFeatureFlagOverrides(): void {
    if (!this.canUseFeatureFlagOverrides() || this.overrideStore.size === 0) return;
    this.overrideStore.clearAll();
    this.persistOverridesAndNotify();
  }

  setAllFeatureFlagOverridesToBundledValues(): void {
    if (!this.canUseFeatureFlagOverrides()) return;
    this.overrideStore.setAllToBundledDefaults();
    this.persistOverridesAndNotify();
  }

  replaceFeatureFlagOverrides(overrides: Record<string, boolean>): void {
    this.overrideStore.replaceAll(overrides);
    this.persistOverridesAndNotify();
  }

  getFeatureFlagOverridesRecord(): Partial<Record<FeatureFlagName, boolean>> {
    return this.overrideStore.activeRecord();
  }

  applyFeatureFlagOverrideCommand(
    command:
      | { kind: "set"; name: string; value: boolean }
      | { kind: "clear"; name: string }
      | { kind: "clear-all" }
      | { kind: "set-all-bundled" },
  ): void {
    switch (command.kind) {
      case "set":
        if (isFlagName(command.name)) this.setFeatureFlagOverride(command.name, command.value);
        return;
      case "clear":
        if (isFlagName(command.name)) this.clearFeatureFlagOverride(command.name);
        return;
      case "clear-all":
        this.clearAllFeatureFlagOverrides();
        return;
      case "set-all-bundled":
        this.setAllFeatureFlagOverridesToBundledValues();
    }
  }

  async checkGate(name: FeatureFlagName, options?: { timeoutMs?: number }): Promise<boolean> {
    await this.whenBootstrapIsLive(options?.timeoutMs);
    return this.checkFeatureGate(name);
  }

  getExperiment(name: ExperimentName): Record<string, unknown> {
    const fallback = EXPERIMENTS[name].fallbackValues as Record<string, unknown>;
    if (this.client == null) return fallback;

    try {
      return { ...fallback, ...this.client.getExperiment(name, CLIENT_READ_OPTIONS).value };
    } catch {
      return fallback;
    }
  }

  getExperimentGroupName(name: ExperimentName): string | null {
    if (this.client == null) return null;
    try {
      return this.client.getExperiment(name, CLIENT_READ_OPTIONS).groupName ?? null;
    } catch {
      return null;
    }
  }

  hasHydratedExperimentUser(): boolean {
    return this.hydratedUserId != null && this.hydratedUserId.length > 0;
  }

  async waitForHydratedExperimentUser(timeoutMs = 60_000): Promise<boolean> {
    if (this.hasHydratedExperimentUser()) return true;
    if (this.hydratedUserWaiter == null) {
      this.hydratedUserWaiter = new Promise((resolve) => {
        this.resolveHydratedUserWaiter = resolve;
      });
    }

    const deadline = createDeadlinePolicy(realClock, { name: "slate-experiments-hydrated-user", timeoutMs });
    try {
      return await deadline.run(() => this.hydratedUserWaiter as Promise<boolean>);
    } catch (error) {
      if (error instanceof DeadlineExceededError) return false;
      throw error;
    }
  }

  getSlateModelExperimentState(): unknown {
    const envValue = readSlateModelExperimentEnvOverride(this.options.env);
    if (envValue != null) return envValue;
    if (!this.hasHydratedExperimentUser() || !Object.hasOwn(EXPERIMENTS, SLATE_MODEL_EXPERIMENT_NAME)) return undefined;

    const name = SLATE_MODEL_EXPERIMENT_NAME as ExperimentName;
    return resolveSlateModelExperimentState({
      groupName: this.getExperimentGroupName(name),
      enabled: this.getExperiment(name).enabled === true,
    });
  }

  logSlateModelExperimentExposure(): boolean {
    if (this.client == null || !this.hasHydratedExperimentUser() || !Object.hasOwn(EXPERIMENTS, SLATE_MODEL_EXPERIMENT_NAME)) {
      return false;
    }

    try {
      const experiment = this.client.getExperiment(SLATE_MODEL_EXPERIMENT_NAME, CLIENT_READ_OPTIONS);
      if (experiment.groupName == null) return false;
      this.client.getExperiment(SLATE_MODEL_EXPERIMENT_NAME);
      void this.client.flush().catch((error) =>
        reportExperimentsDiagnostic({ kind: "exposure_flush_failed", errorClass: errorLogTag(error) }),
      );
      return true;
    } catch {
      return false;
    }
  }

  getDynamicConfig(name: DynamicConfigName): Record<string, unknown> {
    const fallback = DYNAMIC_CONFIGS[name].fallbackValues as Record<string, unknown>;
    if (this.client == null) return fallback;

    try {
      return { ...fallback, ...this.client.getDynamicConfig(name, CLIENT_READ_OPTIONS).value };
    } catch {
      return fallback;
    }
  }

  getConfiguredDefaultModel() {
    return this.resolveConfiguredModel(SLATE_DEFAULT_MODEL_CONFIG_NAME);
  }

  getConfiguredAutomationsModel() {
    return this.resolveConfiguredModel(SLATE_AUTOMATIONS_MODEL_CONFIG_NAME);
  }

  getComputerUseModelOverride(): Record<string, unknown> | undefined {
    return this.checkFeatureGate("slate_computer_use_playwright")
      ? this.getDynamicConfig("slate_computer_use_playwright_config")
      : undefined;
  }

  getBrowserUseModelOverride(): Record<string, unknown> | undefined {
    return this.checkFeatureGate("slate_browser_use_subagent")
      ? this.getDynamicConfig("slate_browser_use_model")
      : undefined;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.pollHandle?.dispose();
    this.pollHandle = undefined;
    this.resolveHydratedUserWaiter?.(false);
    this.resolveHydratedUserWaiter = null;
    this.hydratedUserWaiter = null;
    this.authenticatedBootstrap = false;
    this.listeners.clear();
    for (const property of this.gateProperties.values()) property.clearListeners();

    const client = this.client;
    this.client = null;
    try {
      await client?.shutdown();
    } catch (error) {
      reportExperimentsDiagnostic({ kind: "shutdown_failed", errorClass: errorLogTag(error) });
    }
  }

  private refresh(trigger: RefreshTrigger): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.refreshing) {
      this.queuedTrigger = trigger;
      return this.activeRefresh ?? Promise.resolve();
    }

    this.refreshing = true;
    const work = this.runRefresh(trigger);
    this.activeRefresh = work;
    return work;
  }

  private async waitOutRateLimit(): Promise<void> {
    if (this.rateLimitedUntil == null) return;
    const remaining = Math.max(0, this.rateLimitedUntil - realClock.now());
    if (remaining <= 0) return;
    await new Promise<void>((resolve) => realClock.schedule(remaining, resolve));
  }

  private async runRefresh(trigger: RefreshTrigger): Promise<void> {
    try {
      if (trigger === "auth_change") this.rateLimitedUntil = undefined;
      else {
        await this.waitOutRateLimit();
        if (this.disposed) return;
      }

      const authRevision = this.authRevision;
      const result = await fetchExperimentBootstrap({
        backendUrl: getConfiguredBackendUrl(this.options.env),
        deadline: this.bootstrapDeadline,
        getAccessToken: this.options.getAccessToken,
        getMachineId: this.options.getMachineId,
        env: this.options.env,
      });
      if (this.disposed) return;
      if (result.config == null) {
        if (result.retryAfterMs != null && result.retryAfterMs > 0) {
          this.rateLimitedUntil = realClock.now() + result.retryAfterMs;
        }
        return;
      }

      this.rateLimitedUntil = undefined;
      if (authRevision !== this.authRevision) {
        reportExperimentsDiagnostic({ kind: "bootstrap_discarded_auth_changed", stage: trigger });
        return;
      }

      const userId = readExperimentBootstrapUserId(result.config);
      this.hydrate(result.config);
      this.flagsFetchedAt = Date.now();
      this.liveBootstrap = true;
      this.authenticatedBootstrap = userId != null && userId.length > 0;
      await saveCachedBootstrap(this.options.getCacheDir(), {
        config: result.config,
        userId,
        fetchedAtMs: this.flagsFetchedAt,
      });
      this.broadcastSnapshot();
      reportExperimentsDiagnostic({
        kind: "bootstrap_resolved",
        stage: trigger,
        authenticated: this.authenticatedBootstrap,
        gatesOnCount: Object.values(this.snapshot.featureGates).filter(Boolean).length,
      });
    } catch (error) {
      reportExperimentsDiagnostic({ kind: "bootstrap_failed", stage: trigger, errorClass: errorLogTag(error) });
    } finally {
      this.refreshing = false;
      const queued = this.queuedTrigger;
      this.queuedTrigger = null;
      if (queued != null && !this.disposed) void this.refresh(queued);
    }
  }

  private async whenBootstrapIsLive(timeoutMs = GATE_READY_TIMEOUT_MS): Promise<void> {
    if (this.liveBootstrap) return;

    const drainRefreshes = async () => {
      let lastRefresh: Promise<void> | null = null;
      while (!this.liveBootstrap && !this.disposed) {
        const pending = this.activeRefresh;
        if (pending == null || pending === lastRefresh) return;
        lastRefresh = pending;
        await pending;
      }
    };

    if (timeoutMs <= 0) return drainRefreshes();
    const deadline = createDeadlinePolicy(realClock, { name: "slate-experiments-gate-ready", timeoutMs });
    try {
      await deadline.run(drainRefreshes);
    } catch (error) {
      if (!(error instanceof DeadlineExceededError)) throw error;
    }
  }

  private settleHydratedUserWaiter(): void {
    if (!this.hasHydratedExperimentUser()) return;
    this.resolveHydratedUserWaiter?.(true);
    this.resolveHydratedUserWaiter = null;
    this.hydratedUserWaiter = null;
  }

  private hydrate(config: string): void {
    const user = extractExperimentUser(config) as SlateExperimentUser;
    this.hydratedUserId = typeof user.userID === "string" ? user.userID : null;
    if (this.client == null) {
      this.client = new SlateExperimentClient(SLATE_EXPERIMENT_CLIENT_KEY, user, {
        loggingEnabled: "always",
        disableStorage: true,
        logEventCompressionMode: SlateLogEventCompressionMode.Forced,
        networkConfig: {
          api: SLATE_EXPERIMENT_LOG_ENDPOINT,
          networkOverrideFunc: experimentNetworkOverride,
        },
      });
      this.client.dataAdapter.setData(config);
      this.client.initializeSync();
    } else {
      this.client.dataAdapter.setData(config);
      this.client.updateUserSync(user);
    }

    this.initialized = true;
    this.settleHydratedUserWaiter();
  }

  private resolveConfiguredModel(configName: string) {
    const raw = Object.hasOwn(DYNAMIC_CONFIGS, configName)
      ? this.getDynamicConfig(configName as DynamicConfigName)
      : undefined;
    const resolution = resolveSlateDefaultModelConfig({
      raw,
      hasHydratedExperimentUser: this.hasHydratedExperimentUser(),
    });
    if (resolution.rejection != null) this.reportModelConfigRejection(configName, resolution.rejection);
    return resolution.selection;
  }

  private reportModelConfigRejection(configName: string, rejection: ModelConfigRejection): void {
    const previouslyLogged = this.loggedConfigRejections.get(configName) ?? new Set<ModelConfigRejection>();
    this.loggedConfigRejections.set(configName, previouslyLogged);
    if (previouslyLogged.has(rejection)) return;
    previouslyLogged.add(rejection);
    reportExperimentsDiagnostic({ kind: "config_not_applied", stage: configName, reason: rejection });
  }

  private persistOverridesAndNotify(): void {
    void this.overrideStore.persist();
    this.broadcastSnapshot();
  }

  private buildSnapshot(): ExperimentSnapshot {
    return createExperimentSnapshot({
      isInitialized: this.initialized,
      hasAuthenticatedBootstrap: this.authenticatedBootstrap,
      isLiveBootstrap: this.liveBootstrap,
      canUseOverrides: this.canUseFeatureFlagOverrides(),
      readFeatureGate: (name) => this.checkFeatureGate(name),
      readExperiment: (name) => this.getExperiment(name),
      readDynamicConfig: (name) => this.getDynamicConfig(name),
      readModelExperimentState: () => this.getSlateModelExperimentState(),
      readOverrides: () => this.overrideStore.activeOverrides(),
    });
  }

  private broadcastSnapshot(): void {
    this.snapshot = this.buildSnapshot();
    for (const [name, property] of this.gateProperties) {
      property.set(this.snapshot.featureGates[name] ?? false);
    }
    for (const listener of this.listeners) {
      try {
        listener(this.snapshot);
      } catch (error) {
        reportExperimentsDiagnostic({ kind: "snapshot_listener_failed", errorClass: errorLogTag(error) });
      }
    }
  }
}
