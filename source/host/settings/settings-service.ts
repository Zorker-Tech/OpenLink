/**
 * The settings a user has, as a service.
 *
 * What is read and written goes through the store beside it, and what a caller receives is a setting rather than the
 * file it lives in.
 */
import { isKnownTimeZone } from "../../shared/timezone.ts";

export { isKnownTimeZone };
import { join } from "node:path";

import { getSlateRootDir } from "../host-paths.ts";
import { SlateSettingsStore } from "../../shared/node/settings/slate-settings-store.ts";
import type { SlateAgentModelSelection } from "../../shared/agents/slate-agent-model.ts";
import type { SlateLocalToolPermission } from "../../shared/local-tool-permission.ts";
import type { SlateInferenceProvider } from "../../shared/inference-router.ts";
import type { SlateAutoReviewInstructions } from "../../shared/slate-auto-review-instructions.ts";
import type { HostSettingsUpdate } from "./settings-contracts.ts";
import { applyHostSettingsUpdate } from "./settings-update-policy.ts";
import { projectHostSettings } from "./settings-projection.ts";

export type { HostSettingsUpdate } from "./settings-contracts.ts";

export class SettingsService {
  readonly store: SlateSettingsStore;
  private readonly featureFlagOverrideListeners = new Set<(overrides: Record<string, boolean>) => void>();
  private readonly userTimeZoneListeners = new Set<(zone: string | undefined) => void>();
  private readonly changeListeners = new Set<(event: { readonly fields: string[] }) => void>();
  constructor(private readonly settingsPath = join(getSlateRootDir(), "settings.json")) { this.store = new SlateSettingsStore(settingsPath); }
  getSettingsPath(): string { return this.settingsPath; }
  getHostSettings() {
    return projectHostSettings(this.store);
  }
  setHostSettings(update: HostSettingsUpdate) {
    const effects = applyHostSettingsUpdate(this.store, update);
    if (effects.featureFlagOverrides !== undefined) for (const listener of [...this.featureFlagOverrideListeners]) listener(effects.featureFlagOverrides);
    if (effects.userTimeZone !== effects.previousUserTimeZone) for (const listener of [...this.userTimeZoneListeners]) listener(effects.userTimeZone);
    if (effects.changedFields.length > 0) for (const listener of [...this.changeListeners]) listener({ fields: [...effects.changedFields] });
    return this.getHostSettings();
  }
  subscribeToChanges(listener: (event: { readonly fields: string[] }) => void): () => void { this.changeListeners.add(listener); return () => this.changeListeners.delete(listener); }
  getAgentDefaultModel(): SlateAgentModelSelection | undefined { return this.store.getAgentDefaultModel(); }
  getComputerUseModel(): SlateAgentModelSelection | undefined { return this.store.getComputerUseModel(); }
  getUserTimeZone(): string | undefined { return this.store.getUserTimeZone(); }
  getAutoReviewInstructions(): SlateAutoReviewInstructions { return this.store.getAutoReviewInstructions(); }
  getLocalToolPermission(): SlateLocalToolPermission { return this.store.getLocalToolPermission(); }
  setLocalToolPermission(value: SlateLocalToolPermission): void { this.store.setLocalToolPermission(value); }
  getInferenceProvider(): SlateInferenceProvider { return this.store.getInferenceProvider(); }
  getInferenceRouterUsage() { return this.store.getInferenceRouterUsage(); }
  recordInferenceUsage(provider: SlateInferenceProvider, usage: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number }): void { this.store.recordInferenceUsage(provider, usage); }
  getWebauthnProxyEnabled(): boolean { return this.store.getWebauthnProxyEnabled(); }
  subscribeToFeatureFlagOverrides(listener: (value: Record<string, boolean>) => void): () => void { this.featureFlagOverrideListeners.add(listener); return () => this.featureFlagOverrideListeners.delete(listener); }
  subscribeToUserTimeZone(listener: (value: string | undefined) => void): () => void { this.userTimeZoneListeners.add(listener); return () => this.userTimeZoneListeners.delete(listener); }
  scopeToAccount(value: string): void { this.store.scopeToAccount(value); }
  migrateMcpCustomInstructionToServerId(args: { serverId: string; displayName: string }): void { this.store.migrateMcpCustomInstructionToServerId(args); }
  getMcpCustomInstructions(): Record<string, string> { return this.store.getMcpCustomInstructions(); }
  getMcpCustomInstructionsByServerId(): Record<string, string> { return this.store.getMcpCustomInstructionsByServerId(); }
  getMcpDisabledToolsByServerId(): Record<string, string[]> { return this.store.getMcpDisabledToolsByServerId(); }
  setMcpDisabledToolsByServerId(value: Record<string, string[]>): void { this.store.setMcpDisabledToolsByServerId(value); }
  getRawMcpCustomInstruction(name: string): string | undefined { return this.store.getRawMcpCustomInstruction(name); }
  getRawMcpCustomInstructionByServerId(id: string): string | undefined { return this.store.getRawMcpCustomInstructionByServerId(id); }
  setMcpCustomInstructionByServerId(args: { serverId: string; displayName: string; value: string; mirrorLegacyName: boolean }): void { this.store.setMcpCustomInstructionByServerId(args); }
  deleteMcpCustomInstructionByServerId(args: { serverId: string; displayName: string; deleteLegacyName: boolean }): void { this.store.deleteMcpCustomInstructionByServerId(args); }
}
