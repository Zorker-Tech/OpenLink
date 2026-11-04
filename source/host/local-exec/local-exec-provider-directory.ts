/** Provider identity, liveness and computer selection for local execution. */
import { randomUUID } from "node:crypto";
import type { Clock } from "../extensions/scheduling.ts";
import { SlateLocalExecError } from "./local-exec-error.ts";
import {
  SLATE_LOCAL_EXEC_LIVENESS_WINDOW_MS,
  SLATE_NO_LOCAL_MACHINE_MESSAGE,
  slateComputerUnavailableMessage,
} from "../../shared/local-exec-gateway.ts";
import {
  SLATE_LOCAL_EXEC_PROTOCOL_VERSION,
  isCurrentLocalExecProtocol,
} from "../../shared/local-exec-protocol.ts";
import type {
  LocalExecBridgeFrame,
  LocalExecBridgeDeps,
  LocalExecComputer,
  LocalExecProviderInfo,
  LocalExecProviderReport,
  LocalExecRefusedReport,
} from "./local-exec-bridge-contracts.ts";
import { DEFAULT_SLATE_COMPUTER_ID, boundedLocalExecVariant, localExecProviderRank } from "./local-exec-bridge-contracts.ts";

export interface LocalExecProvider {
  readonly id: string;
  readonly send: (frame: LocalExecBridgeFrame) => void;
  readonly registeredAt: number;
  lastSeenAt: number;
  hasHeartbeat: boolean;
  info?: LocalExecProviderInfo;
  computerId?: string;
  label?: string;
  supervised?: boolean;
  variant?: string;
  protocolVersion?: typeof SLATE_LOCAL_EXEC_PROTOCOL_VERSION;
}

export interface ProviderDirectoryOptions {
  clock: Clock;
  report?: LocalExecBridgeDeps["report"];
  randomId?: () => string;
}

export class LocalExecProviderDirectory {
  private readonly providers = new Set<LocalExecProvider>();
  private readonly byId = new Map<string, LocalExecProvider>();
  private everRegistered = false;
  private emptySince: number;

  constructor(private readonly options: ProviderDirectoryOptions) {
    this.emptySince = options.clock.now();
  }

  register(send: (frame: LocalExecBridgeFrame) => void): () => void {
    const provider: LocalExecProvider = {
      id: this.options.randomId?.() ?? randomUUID(),
      send,
      registeredAt: this.options.clock.now(),
      lastSeenAt: this.options.clock.now(),
      hasHeartbeat: false,
    };
    this.providers.add(provider);
    this.byId.set(provider.id, provider);
    this.everRegistered = true;
    this.reportProvider({ phase: "registered", providerId: provider.id, providerCount: this.providers.size });
    try {
      send({ kind: "welcome", providerId: provider.id, protocolVersion: SLATE_LOCAL_EXEC_PROTOCOL_VERSION });
    } catch {
      // The remote side may have gone away while it was being welcomed.
    }

    return () => this.detach(provider);
  }

  private detach(provider: LocalExecProvider): void {
    if (!this.providers.delete(provider)) return;
    if (this.byId.get(provider.id) === provider) this.byId.delete(provider.id);
    const now = this.options.clock.now();
    const emptied = this.providers.size === 0;
    if (emptied) this.emptySince = now;
    this.reportProvider({
      phase: "detached",
      providerId: provider.id,
      providerCount: this.providers.size,
      ageMs: now - provider.registeredAt,
      hadHello: provider.info !== undefined,
      hasHeartbeat: provider.hasHeartbeat,
      wasLive: this.isLive(provider, now),
      emptied,
    });
  }

  hasProvider(): boolean {
    return this.providers.size > 0;
  }

  isComputerLive(computerId: string): boolean {
    return this.resolve(computerId) !== undefined;
  }

  assertComputerAvailable(computerId: string | undefined, gate: { readonly site: string; readonly agentId?: string }): void {
    this.require(computerId, gate);
  }

  checkLiveComputerForAsk(agentId?: string): boolean {
    if (this.resolve(undefined) !== undefined) return true;
    const cause = this.providers.size === 0 ? "no_providers" : "stale_heartbeat";
    this.reportRefused(cause, { site: "ask_gate", ...(agentId === undefined ? {} : { agentId }) });
    return false;
  }

  require(computerId: string | undefined, gate: { readonly site: string; readonly agentId?: string }): LocalExecProvider {
    const provider = this.resolve(computerId);
    if (provider !== undefined) return provider;
    if (this.providers.size === 0) {
      this.reportRefused("no_providers", gate);
      throw new SlateLocalExecError(SLATE_NO_LOCAL_MACHINE_MESSAGE);
    }
    if (computerId !== undefined && !this.hasComputerId(computerId)) {
      this.reportRefused("computer_unknown", gate);
      throw new SlateLocalExecError(SLATE_NO_LOCAL_MACHINE_MESSAGE);
    }
    this.reportRefused("stale_heartbeat", gate);
    throw new SlateLocalExecError(slateComputerUnavailableMessage(this.routeLabel(computerId)));
  }

  listComputers(): LocalExecComputer[] {
    const now = this.options.clock.now();
    const newestByComputer = new Map<string, LocalExecProvider>();
    for (const provider of this.providers) {
      const computerId = this.computerId(provider);
      const known = newestByComputer.get(computerId);
      if (known === undefined || provider.lastSeenAt >= known.lastSeenAt) newestByComputer.set(computerId, provider);
    }
    return [...newestByComputer].map(([id, provider]) => ({
      id,
      label: provider.label ?? "this computer",
      connected: this.isLive(provider, now),
    }));
  }

  activeComputer(): LocalExecComputer | undefined {
    const provider = this.resolve(undefined);
    return provider === undefined ? undefined : {
      id: this.computerId(provider),
      label: provider.label ?? "this computer",
      connected: true,
    };
  }

  getProviderInfo(): LocalExecProviderInfo | undefined {
    return (this.resolve(undefined) ?? [...this.providers].at(-1))?.info;
  }

  providerForBatch(providerId?: string): LocalExecProvider | undefined {
    return (providerId === undefined ? undefined : this.byId.get(providerId)) ?? [...this.providers].at(-1);
  }

  all(): LocalExecProvider[] {
    return [...this.providers];
  }

  acceptHello(provider: LocalExecProvider, frame: LocalExecBridgeFrame): void {
    if (typeof frame.localRoot !== "string" || typeof frame.terminalsFolder !== "string") return;
    if (frame.protocolVersion !== undefined && !isCurrentLocalExecProtocol(frame)) return;
    const rehello = provider.info !== undefined;
    provider.info = { localRoot: frame.localRoot, terminalsFolder: frame.terminalsFolder };
    if (typeof frame.computerId === "string" && frame.computerId.length > 0) provider.computerId = frame.computerId;
    if (typeof frame.label === "string" && frame.label.length > 0) provider.label = frame.label;
    if (typeof frame.supervised === "boolean") provider.supervised = frame.supervised;
    if (typeof frame.variant === "string" && frame.variant.length > 0) provider.variant = frame.variant;
    if (isCurrentLocalExecProtocol(frame)) provider.protocolVersion = SLATE_LOCAL_EXEC_PROTOCOL_VERSION;
    provider.lastSeenAt = this.options.clock.now();

    const variant = boundedLocalExecVariant(provider.variant);
    this.reportProvider({
      phase: "hello",
      providerId: provider.id,
      providerCount: this.providers.size,
      helloDelayMs: provider.lastSeenAt - provider.registeredAt,
      computerIdPresent: provider.computerId !== undefined,
      rehello,
      protocolVersion: provider.protocolVersion ?? "legacy",
      ...(provider.supervised === undefined ? {} : { supervised: provider.supervised }),
      ...(variant === undefined ? {} : { variant }),
    });
  }

  acceptHeartbeat(provider: LocalExecProvider, frame: LocalExecBridgeFrame): void {
    provider.hasHeartbeat = true;
    provider.lastSeenAt = this.options.clock.now();
    if (typeof frame.supervised === "boolean") provider.supervised = frame.supervised;
  }

  private computerId(provider: LocalExecProvider): string {
    return provider.computerId ?? DEFAULT_SLATE_COMPUTER_ID;
  }

  private isLive(provider: LocalExecProvider, now = this.options.clock.now()): boolean {
    return !provider.hasHeartbeat || now - provider.lastSeenAt <= SLATE_LOCAL_EXEC_LIVENESS_WINDOW_MS;
  }

  private liveProviders(): LocalExecProvider[] {
    const now = this.options.clock.now();
    return [...this.providers].filter(provider => this.isLive(provider, now));
  }

  private best(candidates: readonly LocalExecProvider[]): LocalExecProvider | undefined {
    let selected: LocalExecProvider | undefined;
    for (const candidate of candidates) {
      if (selected === undefined
        || localExecProviderRank(candidate) > localExecProviderRank(selected)
        || (localExecProviderRank(candidate) === localExecProviderRank(selected) && candidate.lastSeenAt >= selected.lastSeenAt)) {
        selected = candidate;
      }
    }
    return selected;
  }

  private hasComputerId(computerId: string): boolean {
    return [...this.providers].some(provider => this.computerId(provider) === computerId);
  }

  private routeLabel(computerId?: string): string | undefined {
    if (computerId !== undefined) {
      return [...this.providers].find(provider => this.computerId(provider) === computerId)?.label ?? computerId;
    }
    return this.best([...this.providers])?.label;
  }

  private resolve(computerId?: string): LocalExecProvider | undefined {
    const live = this.liveProviders();
    return computerId === undefined ? this.best(live) : this.best(live.filter(provider => this.computerId(provider) === computerId));
  }

  private reportProvider(report: LocalExecProviderReport): void {
    this.options.report?.provider?.(report);
  }

  private reportRefused(
    cause: LocalExecRefusedReport["cause"],
    gate: { readonly site: string; readonly agentId?: string },
  ): void {
    this.options.report?.refused?.({
      cause,
      site: gate.site,
      ...(gate.agentId === undefined ? {} : { conversationId: gate.agentId }),
      providerCount: this.providers.size,
      liveProviderCount: this.liveProviders().length,
      everRegistered: this.everRegistered,
      ...(cause === "no_providers" ? { emptyForMs: this.options.clock.now() - this.emptySince } : {}),
    });
  }
}
