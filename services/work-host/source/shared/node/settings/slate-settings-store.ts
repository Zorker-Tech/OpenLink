/**
 * Where the platform keeps a user's own settings.
 *
 * One file holds them, written atomically and read defensively — a setting whose value is not one the platform knows is
 * dropped rather than trusted — and what a caller is handed is the setting, not the file.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { DEFAULT_SLATE_THEME_PREFERENCE, isSlateThemePreference, type SlateThemePreference } from "../../desktop.ts";
import { SLATE_DISABLED_NOTIFICATION_CONFIG } from "../../host-settings.ts";
import { SLATE_DEFAULT_LOCAL_TOOL_PERMISSION, isSlateLocalToolPermission, resolveSlateLocalToolPermission, type SlateLocalToolPermission } from "../../local-tool-permission.ts";
import { clampMcpCustomInstruction, getDefaultMcpCustomInstruction } from "../../mcp-custom-instructions.ts";
import { DEFAULT_SLATE_AUTO_REVIEW_INSTRUCTIONS, normalizeSlateAutoReviewInstructions, type SlateAutoReviewInstructions } from "../../slate-auto-review-instructions.ts";
import { SidebarGrouping, type SidebarSection } from "../../sidebar-sections.ts";
import { coerceToEnabledTrack, isSlateUpdateTrack, type SlateUpdateTrack } from "../../update-track.ts";
import { isSlateAgentModelSelection, type SlateAgentModelSelection } from "../../agents/slate-agent-model.ts";
import { emptySlateInferenceRouterUsage, isSlateInferenceProvider, type SlateInferenceProvider, type SlateInferenceRouterUsage } from "../../inference-router.ts";
import { DEFAULT_SLATE_BOX_RUNTIME, isBoxRuntime, type BoxRuntime } from "../../box-runtime.ts";

export const SETTINGS_VERSION = 1;
export const SLATE_DOWNGRADE_MAX_FAST_MIGRATION_ID = "downgrade-persisted-max-fast";
export const SLATE_SETTINGS_MIGRATION_IDS = [SLATE_DOWNGRADE_MAX_FAST_MIGRATION_ID] as const;

type StringMap = Record<string, string>;
type StringListMap = Record<string, string[]>;
export interface SlateStoredSettings {
  version: 1; mcpBoxServers: string[]; autoUpdateWhenIdleOptIn: boolean; egressTunnelEnabled: boolean; webauthnProxyEnabled: boolean;
  mcpCustomInstructions: StringMap; mcpCustomInstructionsByServerId: StringMap; mcpDisabledToolsByServerId: StringListMap;
  conciergeConsent: "unset" | "allowed" | "denied"; settingsMigrations: string[];
  hasSeenOnboarding?: boolean; hasSeenOnboardingAccountScope?: string; updateTrackOverride?: SlateUpdateTrack; themePreference?: SlateThemePreference;
  agentDefaultModel?: SlateAgentModelSelection; computerUseModel?: SlateAgentModelSelection; notifications?: Record<string, unknown>;
  userTimeZone?: string; userTimeZoneOverride?: string; autoReviewInstructions?: SlateAutoReviewInstructions;
  localToolPermission?: SlateLocalToolPermission; localToolPermissionCeiling?: SlateLocalToolPermission;
  inferenceProvider?: SlateInferenceProvider; inferenceRouterUsage?: SlateInferenceRouterUsage;
  boxRuntime?: BoxRuntime;
  mcpCustomInstructionsAccountScope?: string; pinnedAgentIds?: string[]; sidebarSections?: SidebarSection[];
}

export function emptySettings(): SlateStoredSettings {
  return { version: SETTINGS_VERSION, mcpBoxServers: [], autoUpdateWhenIdleOptIn: false, egressTunnelEnabled: false, webauthnProxyEnabled: true, mcpCustomInstructions: {}, mcpCustomInstructionsByServerId: {}, mcpDisabledToolsByServerId: {}, conciergeConsent: "unset", settingsMigrations: [...SLATE_SETTINGS_MIGRATION_IDS] };
}

function stringRecordOf(value: unknown): StringMap { const parsed: StringMap = {}; if (typeof value !== "object" || value == null || Array.isArray(value)) return parsed; for (const [key, entry] of Object.entries(value)) if (typeof entry === "string") parsed[key] = entry; return parsed; }
function stringListOf(value: unknown): string[] { return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []; }
function clampedInstructions(fields: StringMap): StringMap { const normalized: StringMap = {}; for (const [name, value] of Object.entries(fields)) { const clamped = clampMcpCustomInstruction(value); if (clamped.trim().length > 0) normalized[name] = clamped; else if (getDefaultMcpCustomInstruction(name).length > 0) normalized[name] = ""; } return normalized; }
function clampedInstructionsById(fields: StringMap): StringMap { const normalized: StringMap = {}; for (const [id, value] of Object.entries(fields)) if (/^[1-9]\d*$/.test(id)) normalized[id] = clampMcpCustomInstruction(value); return normalized; }
function disabledToolsByServerIdOf(fields: unknown): StringListMap { const normalized: StringListMap = {}; if (typeof fields !== "object" || fields == null || Array.isArray(fields)) return normalized; for (const [id, value] of Object.entries(fields)) { if (!/^[1-9]\d*$/.test(id)) continue; const tools = [...new Set(stringListOf(value).filter((name) => name.length > 0))]; if (tools.length > 0) normalized[id] = tools; } return normalized; }
function downgradeFastSelection(model: SlateAgentModelSelection): SlateAgentModelSelection { return { modelId: model.modelId, maxMode: true, parameters: model.parameters.map((parameter) => ({ id: parameter.id, value: parameter.id === "fast" ? "false" : parameter.value })) }; }

function parseStoredSettings(value: unknown): SlateStoredSettings | null {
  if (typeof value !== "object" || value == null || Array.isArray(value)) return null;
  const fields = value as Record<string, unknown>; if (fields.version !== SETTINGS_VERSION) return null;
  const defaults = emptySettings();
  const parsed: SlateStoredSettings = {
    ...defaults,
    mcpBoxServers: [...new Set(stringListOf(fields.mcpBoxServers).filter((name) => name.length > 0))],
    autoUpdateWhenIdleOptIn: fields.autoUpdateWhenIdleOptIn === true,
    egressTunnelEnabled: fields.egressTunnelEnabled === true,
    webauthnProxyEnabled: fields.webauthnProxyEnabled !== false,
    mcpCustomInstructions: clampedInstructions(stringRecordOf(fields.mcpCustomInstructions)),
    mcpCustomInstructionsByServerId: clampedInstructionsById(stringRecordOf(fields.mcpCustomInstructionsByServerId)),
    mcpDisabledToolsByServerId: disabledToolsByServerIdOf(fields.mcpDisabledToolsByServerId),
    conciergeConsent: fields.conciergeConsent === "allowed" || fields.conciergeConsent === "denied" ? fields.conciergeConsent : "unset",
    settingsMigrations: stringListOf(fields.settingsMigrations)
  };
  if (typeof fields.hasSeenOnboarding === "boolean") parsed.hasSeenOnboarding = fields.hasSeenOnboarding;
  if (typeof fields.hasSeenOnboardingAccountScope === "string" && fields.hasSeenOnboardingAccountScope.length > 0) parsed.hasSeenOnboardingAccountScope = fields.hasSeenOnboardingAccountScope;
  if (isSlateUpdateTrack(fields.updateTrackOverride)) parsed.updateTrackOverride = fields.updateTrackOverride;
  if (isSlateThemePreference(fields.themePreference)) parsed.themePreference = fields.themePreference;
  if (isSlateAgentModelSelection(fields.agentDefaultModel)) parsed.agentDefaultModel = fields.agentDefaultModel;
  if (isSlateAgentModelSelection(fields.computerUseModel)) parsed.computerUseModel = fields.computerUseModel;
  if (typeof fields.notifications === "object" && fields.notifications != null && !Array.isArray(fields.notifications)) parsed.notifications = fields.notifications as Record<string, unknown>;
  for (const key of ["userTimeZone", "userTimeZoneOverride", "mcpCustomInstructionsAccountScope"] as const) if (typeof fields[key] === "string" && fields[key].length > 0) parsed[key] = fields[key];
  if (typeof fields.autoReviewInstructions === "object" && fields.autoReviewInstructions != null) parsed.autoReviewInstructions = normalizeSlateAutoReviewInstructions(fields.autoReviewInstructions as Record<string, unknown>);
  if (isSlateLocalToolPermission(fields.localToolPermission)) parsed.localToolPermission = fields.localToolPermission;
  if (isSlateLocalToolPermission(fields.localToolPermissionCeiling)) parsed.localToolPermissionCeiling = fields.localToolPermissionCeiling;
  if (isSlateInferenceProvider(fields.inferenceProvider)) parsed.inferenceProvider = fields.inferenceProvider;
  if (isBoxRuntime(fields.boxRuntime)) parsed.boxRuntime = fields.boxRuntime;
  if (typeof fields.inferenceRouterUsage === "object" && fields.inferenceRouterUsage != null && !Array.isArray(fields.inferenceRouterUsage)) {
    const routerUsage = emptySlateInferenceRouterUsage();
    const providerRecords = (fields.inferenceRouterUsage as { providers?: unknown }).providers;
    if (typeof providerRecords === "object" && providerRecords != null && !Array.isArray(providerRecords)) {
      for (const providerKey of Object.keys(routerUsage.providers) as SlateInferenceProvider[]) {
        const entry = (providerRecords as Record<string, unknown>)[providerKey];
        if (typeof entry !== "object" || entry == null || Array.isArray(entry)) continue;
        const providerRecord = entry as Record<string, unknown>;
        const counterOf = (key: string): number => Number.isSafeInteger(providerRecord[key]) && (providerRecord[key] as number) >= 0 ? providerRecord[key] as number : 0;
        routerUsage.providers[providerKey] = { requests: counterOf("requests"), inputTokens: counterOf("inputTokens"), outputTokens: counterOf("outputTokens"), cacheReadTokens: counterOf("cacheReadTokens"), cacheWriteTokens: counterOf("cacheWriteTokens"), lastUsedAt: typeof providerRecord.lastUsedAt === "string" ? providerRecord.lastUsedAt : null };
      }
    }
    parsed.inferenceRouterUsage = routerUsage;
  }
  if (Array.isArray(fields.pinnedAgentIds)) parsed.pinnedAgentIds = [...new Set(stringListOf(fields.pinnedAgentIds).filter((id) => id.length > 0))];
  if (Array.isArray(fields.sidebarSections)) parsed.sidebarSections = SidebarGrouping.foldsCarried({ sections: fields.sidebarSections.filter((entry): entry is SidebarSection => typeof entry === "object" && entry != null && typeof (entry as { id?: unknown }).id === "string" && typeof (entry as { name?: unknown }).name === "string" && Array.isArray((entry as { agentIds?: unknown }).agentIds)) });
  return parsed;
}

export class SlateSettingsStore {
  constructor(readonly settingsPath: string) {}
  load(): SlateStoredSettings {
    if (!existsSync(this.settingsPath)) return emptySettings();
    try { const parsed = parseStoredSettings(JSON.parse(readFileSync(this.settingsPath, "utf8")) as unknown); return parsed == null ? emptySettings() : this.migrateOnLoad(parsed); }
    catch { return emptySettings(); }
  }
  private migrateOnLoad(settings: SlateStoredSettings): SlateStoredSettings {
    if (settings.settingsMigrations.includes(SLATE_DOWNGRADE_MAX_FAST_MIGRATION_ID)) return settings;
    const migrated = { ...settings, settingsMigrations: [...settings.settingsMigrations, SLATE_DOWNGRADE_MAX_FAST_MIGRATION_ID], ...(settings.agentDefaultModel === undefined ? {} : { agentDefaultModel: downgradeFastSelection(settings.agentDefaultModel) }) };
    try { this.persist(migrated); } catch {}
    return migrated;
  }
  persist(settings: SlateStoredSettings): void { mkdirSync(dirname(this.settingsPath), { recursive: true }); const tempPath = `${this.settingsPath}.${process.pid}.tmp`; writeFileSync(tempPath, JSON.stringify(settings, null, 2), "utf8"); renameSync(tempPath, this.settingsPath); }
  private update(mutate: (settings: SlateStoredSettings) => SlateStoredSettings): void { this.persist(mutate(this.load())); }
  getHasSeenOnboarding(): boolean | undefined { return this.load().hasSeenOnboarding; }
  setHasSeenOnboarding(value: boolean): void { this.update((loaded) => { const { hasSeenOnboardingAccountScope: _old, ...remainder } = loaded; return { ...remainder, hasSeenOnboarding: value, ...(remainder.mcpCustomInstructionsAccountScope === undefined ? {} : { hasSeenOnboardingAccountScope: remainder.mcpCustomInstructionsAccountScope }) }; }); }
  clearHasSeenOnboarding(): void { this.update((loaded) => { const { hasSeenOnboarding: _seen, hasSeenOnboardingAccountScope: _owner, ...remainder } = loaded; return remainder; }); }
  getAutoUpdateWhenIdleOptIn(): boolean { return this.load().autoUpdateWhenIdleOptIn; }
  setAutoUpdateWhenIdleOptIn(value: boolean): void { this.update((s) => ({ ...s, autoUpdateWhenIdleOptIn: value })); }
  getThemePreference(): SlateThemePreference { return this.load().themePreference ?? DEFAULT_SLATE_THEME_PREFERENCE; }
  setThemePreference(value: SlateThemePreference): void { this.update((s) => ({ ...s, themePreference: value })); }
  getBoxRuntime(): BoxRuntime { return this.load().boxRuntime ?? DEFAULT_SLATE_BOX_RUNTIME; }
  setBoxRuntime(value: BoxRuntime): void { this.update((s) => ({ ...s, boxRuntime: value })); }
  getEgressTunnelEnabled(): boolean { return this.load().egressTunnelEnabled; }
  setEgressTunnelEnabled(value: boolean): void { this.update((s) => ({ ...s, egressTunnelEnabled: value })); }
  getWebauthnProxyEnabled(): boolean { return this.load().webauthnProxyEnabled; }
  setWebauthnProxyEnabled(value: boolean): void { this.update((s) => ({ ...s, webauthnProxyEnabled: value })); }
  getAgentDefaultModel(): SlateAgentModelSelection | undefined { const model = this.load().agentDefaultModel; return model === undefined ? undefined : { ...model, maxMode: true }; }
  setAgentDefaultModel(model: SlateAgentModelSelection | undefined): void { this.update((s) => { const { agentDefaultModel: _old, ...remainder } = s; return model === undefined ? remainder : { ...remainder, agentDefaultModel: { modelId: model.modelId, maxMode: true, parameters: model.parameters.map((p) => ({ ...p })) } }; }); }
  getComputerUseModel(): SlateAgentModelSelection | undefined { return this.load().computerUseModel; }
  setComputerUseModel(model: SlateAgentModelSelection | undefined): void { this.update((s) => { const { computerUseModel: _old, ...remainder } = s; return model === undefined ? remainder : { ...remainder, computerUseModel: { modelId: model.modelId, maxMode: model.maxMode, parameters: model.parameters.map((p) => ({ ...p })) } }; }); }
  getUpdateTrackOverride(): SlateUpdateTrack | null { const stored = this.load().updateTrackOverride ?? null; if (stored == null) return null; const coerced = coerceToEnabledTrack(stored); if (coerced !== stored) { try { this.setUpdateTrackOverride(coerced); } catch {} } return coerced; }
  setUpdateTrackOverride(track: SlateUpdateTrack | null): void { this.update((s) => { const { updateTrackOverride: _old, ...remainder } = s; return track == null ? remainder : { ...remainder, updateTrackOverride: track }; }); }
  getMcpCustomInstructions(): StringMap { return this.load().mcpCustomInstructions; }
  setMcpCustomInstructions(value: StringMap): void { this.update((s) => ({ ...s, mcpCustomInstructions: clampedInstructions(value) })); }
  getMcpCustomInstructionsByServerId(): StringMap { return this.load().mcpCustomInstructionsByServerId; }
  setMcpCustomInstructionsByServerId(value: StringMap): void { this.update((s) => ({ ...s, mcpCustomInstructionsByServerId: clampedInstructionsById(value) })); }
  getMcpCustomInstructionsAccountScope(): string | undefined { return this.load().mcpCustomInstructionsAccountScope; }
  getMcpDisabledToolsByServerId(): StringListMap { return this.load().mcpDisabledToolsByServerId; }
  setMcpDisabledToolsByServerId(value: StringListMap): void { this.update((s) => ({ ...s, mcpDisabledToolsByServerId: disabledToolsByServerIdOf(value) })); }
  scopeToAccount(accountScope: string): void { this.update((loaded) => { const carriedSeen = loaded.hasSeenOnboarding === undefined || (loaded.hasSeenOnboardingAccountScope !== undefined && loaded.hasSeenOnboardingAccountScope !== accountScope) ? {} : { hasSeenOnboarding: loaded.hasSeenOnboarding, hasSeenOnboardingAccountScope: accountScope }; const { hasSeenOnboarding: _seen, hasSeenOnboardingAccountScope: _owner, ...withoutSeenState } = loaded; if (loaded.mcpCustomInstructionsAccountScope === undefined || loaded.mcpCustomInstructionsAccountScope === accountScope) return { ...withoutSeenState, ...carriedSeen, mcpCustomInstructionsAccountScope: accountScope }; const { autoReviewInstructions: _a, agentDefaultModel: _m, computerUseModel: _c, localToolPermission: _p, localToolPermissionCeiling: _pc, ...remainder } = withoutSeenState; return { ...remainder, ...carriedSeen, mcpCustomInstructionsAccountScope: accountScope, mcpCustomInstructions: {}, mcpCustomInstructionsByServerId: {}, mcpDisabledToolsByServerId: {} }; }); }
  clearAccountScope(): void { this.update((loaded) => { const { mcpCustomInstructionsAccountScope: _scope, autoReviewInstructions: _a, agentDefaultModel: _m, computerUseModel: _c, localToolPermission: _p, localToolPermissionCeiling: _pc, ...remainder } = loaded; return { ...remainder, mcpCustomInstructions: {}, mcpCustomInstructionsByServerId: {}, mcpDisabledToolsByServerId: {} }; }); }
  getUserTimeZone(): string | undefined { const s = this.load(); return s.userTimeZoneOverride ?? s.userTimeZone; }
  getDetectedUserTimeZone(): string | undefined { return this.load().userTimeZone; }
  getUserTimeZoneOverride(): string | undefined { return this.load().userTimeZoneOverride; }
  setUserTimeZone(value?: string): void { this.update((s) => { const { userTimeZone: _old, ...remainder } = s; const trimmed = value?.trim(); return trimmed == null || trimmed.length === 0 ? remainder : { ...remainder, userTimeZone: trimmed }; }); }
  setUserTimeZoneOverride(value?: string): void { this.update((s) => { const { userTimeZoneOverride: _old, ...remainder } = s; const trimmed = value?.trim(); return trimmed == null || trimmed.length === 0 ? remainder : { ...remainder, userTimeZoneOverride: trimmed }; }); }
  getMcpBoxServers(): string[] { return this.load().mcpBoxServers; }
  setMcpBoxServers(names: readonly string[]): void { this.update((s) => ({ ...s, mcpBoxServers: [...new Set(names)] })); }
  getRawMcpCustomInstruction(name: string): string | undefined { return this.load().mcpCustomInstructions[name]; }
  getRawMcpCustomInstructionByServerId(id: string): string | undefined { return this.load().mcpCustomInstructionsByServerId[id]; }
  setMcpCustomInstructionByServerId(args: { serverId: string; displayName: string; value: string; mirrorLegacyName: boolean }): void { this.update((s) => { const byServerId = { ...s.mcpCustomInstructionsByServerId, [args.serverId]: clampMcpCustomInstruction(args.value) }; const legacyInstructions = { ...s.mcpCustomInstructions }; if (args.mirrorLegacyName) { const value = clampMcpCustomInstruction(args.value); if (value.trim().length > 0 || getDefaultMcpCustomInstruction(args.displayName).length > 0) legacyInstructions[args.displayName] = value; else delete legacyInstructions[args.displayName]; } else delete legacyInstructions[args.displayName]; return { ...s, mcpCustomInstructionsByServerId: byServerId, mcpCustomInstructions: legacyInstructions }; }); }
  migrateMcpCustomInstructionToServerId(args: { serverId: string; displayName: string }): void { const loaded = this.load(); if (loaded.mcpCustomInstructionsByServerId[args.serverId] !== undefined) return; const legacyInstructions = loaded.mcpCustomInstructions[args.displayName]; if (legacyInstructions === undefined) return; this.persist({ ...loaded, mcpCustomInstructionsByServerId: { ...loaded.mcpCustomInstructionsByServerId, [args.serverId]: legacyInstructions } }); }
  deleteMcpCustomInstructionByServerId(args: { serverId: string; displayName: string; deleteLegacyName: boolean }): void { this.update((s) => { const byServerId = { ...s.mcpCustomInstructionsByServerId }; delete byServerId[args.serverId]; const legacyInstructions = { ...s.mcpCustomInstructions }; if (args.deleteLegacyName) delete legacyInstructions[args.displayName]; return { ...s, mcpCustomInstructionsByServerId: byServerId, mcpCustomInstructions: legacyInstructions }; }); }
  setMcpCustomInstruction(name: string, value: string): void { this.update((s) => { const nextInstructionMap = { ...s.mcpCustomInstructions }; const clamped = clampMcpCustomInstruction(value); if (clamped.trim().length === 0) { if (getDefaultMcpCustomInstruction(name).length > 0) nextInstructionMap[name] = ""; else delete nextInstructionMap[name]; } else nextInstructionMap[name] = clamped; return { ...s, mcpCustomInstructions: nextInstructionMap }; }); }
  deleteMcpCustomInstruction(name: string): void { const loaded = this.load(); if (!(name in loaded.mcpCustomInstructions)) return; const nextInstructionMap = { ...loaded.mcpCustomInstructions }; delete nextInstructionMap[name]; this.persist({ ...loaded, mcpCustomInstructions: nextInstructionMap }); }
  getNotificationConfig() { const loaded = this.load(); if (loaded.notifications?.isEnabled !== false || Object.keys(loaded.notifications).length !== 1) this.persist({ ...loaded, notifications: { isEnabled: false } }); return SLATE_DISABLED_NOTIFICATION_CONFIG; }
  setNotificationConfig(_input: unknown): void { this.update((s) => ({ ...s, notifications: { isEnabled: false } })); }
  getAutoReviewInstructions(): SlateAutoReviewInstructions { return this.load().autoReviewInstructions ?? DEFAULT_SLATE_AUTO_REVIEW_INSTRUCTIONS; }
  setAutoReviewInstructions(value: SlateAutoReviewInstructions): void { const normalized = normalizeSlateAutoReviewInstructions(value); this.update((s) => { const { autoReviewInstructions: _old, ...remainder } = s; return normalized.isEnabled && normalized.allowInstructions.length === 0 && normalized.blockInstructions.length === 0 ? remainder : { ...remainder, autoReviewInstructions: normalized }; }); }
  getLocalToolPermission(): SlateLocalToolPermission { const s = this.load(); return resolveSlateLocalToolPermission(s.localToolPermission ?? SLATE_DEFAULT_LOCAL_TOOL_PERMISSION, s.localToolPermissionCeiling); }
  getLocalToolPermissionChoice(): SlateLocalToolPermission { return this.load().localToolPermission ?? SLATE_DEFAULT_LOCAL_TOOL_PERMISSION; }
  getLocalToolPermissionCeiling(): SlateLocalToolPermission | undefined { return this.load().localToolPermissionCeiling; }
  setLocalToolPermission(value: SlateLocalToolPermission): void { this.update((s) => ({ ...s, localToolPermission: value })); }
  getInferenceProvider(): SlateInferenceProvider { return this.load().inferenceProvider ?? "slate"; }
  setInferenceProvider(value: SlateInferenceProvider): void { this.update((s) => ({ ...s, inferenceProvider: value })); }
  getInferenceRouterUsage(): SlateInferenceRouterUsage { return this.load().inferenceRouterUsage ?? emptySlateInferenceRouterUsage(); }
  recordInferenceUsage(providerKey: SlateInferenceProvider, routerUsage: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number }): void {
    const safe = (value: number | undefined): number => Number.isFinite(value) && value! >= 0 ? Math.round(value!) : 0;
    this.update((settings) => {
      const loaded = settings.inferenceRouterUsage ?? emptySlateInferenceRouterUsage();
      const previous = loaded.providers[providerKey];
      return { ...settings, inferenceRouterUsage: { schemaVersion: 1, providers: { ...loaded.providers, [providerKey]: { requests: previous.requests + 1, inputTokens: previous.inputTokens + safe(routerUsage.inputTokens), outputTokens: previous.outputTokens + safe(routerUsage.outputTokens), cacheReadTokens: previous.cacheReadTokens + safe(routerUsage.cacheReadTokens), cacheWriteTokens: previous.cacheWriteTokens + safe(routerUsage.cacheWriteTokens), lastUsedAt: new Date().toISOString() } } } };
    });
  }
  setLocalToolPermissionCeiling(value?: SlateLocalToolPermission): void { this.update((s) => { const { localToolPermissionCeiling: _old, ...remainder } = s; return value === undefined ? remainder : { ...remainder, localToolPermissionCeiling: value }; }); }
  getPinnedAgentIds(): string[] | undefined { return this.load().pinnedAgentIds; }
  setPinnedAgentIds(ids: readonly string[]): void { this.update((s) => ({ ...s, pinnedAgentIds: [...new Set(ids)] })); }
  static storable(args: { sections: readonly SidebarSection[]; stored?: readonly SidebarSection[] }): SidebarSection[] { return SidebarGrouping.foldsCarried(args).map((s) => ({ id: s.id, name: s.name, agentIds: [...s.agentIds], isCollapsed: s.isCollapsed ?? false })); }
  getSidebarGrouping(): SidebarSection[] | undefined { const stored = this.load().sidebarSections; return stored === undefined ? undefined : SidebarGrouping.foldsCarried({ sections: stored }); }
  setSidebarGrouping(sections: readonly SidebarSection[]): void { this.update((s) => ({ ...s, sidebarSections: SlateSettingsStore.storable(s.sidebarSections === undefined ? { sections } : { sections, stored: s.sidebarSections }) })); }
}
