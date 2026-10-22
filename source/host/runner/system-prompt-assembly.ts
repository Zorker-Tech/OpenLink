/**
 * Putting a turn's system prompt together.
 *
 * The platform's own instructions, the agent's profile, the sections its feature flags call for and the update that
 * tells it the profile changed are assembled in one place, so what the model is told is decided here rather than
 * spread across the runner.
 */
import {
  agentProfileIdentitiesEqual,
  normalizeAgentProfileIdentity,
  renderAgentProfileUpdate,
  resolveAgentProfilePromptSnapshot,
  type AgentProfileIdentity,
  type AgentProfilePromptSnapshot,
} from "./slate-agent-profile-prompt.ts";
import { SLATE_EXTERNAL_SHELL_TOOL_NAME } from "../slate-activity.ts";
import { toModelVisiblePath } from "../host-paths.ts";
import {
  isMemoryFreezeEnabled,
  projectMemoryHasFacts,
  renderMemorySystemPrompt,
  renderProjectMemorySystemPrompt,
  renderUserMemorySystemPrompt,
  resolveFrozenMemoryPrompt,
  type FrozenMemorySnapshot,
  type MemoryRecall,
  type ProjectMemoryBlock,
  type ProvenancedMemory,
} from "./slate-memory.ts";
import {
  SLATE_CLOUD_AGENTS_DISABLED_PROMPT_SECTION,
  SLATE_MCP_MULTI_ACCOUNT_PROMPT_SECTION,
  SLATE_SYSTEM_PROMPT_CLOUD_AGENTS_DISABLED,
} from "./system-prompt.ts";
import { renderAutomationsSystemPrompt, type AutomationRecord } from "../automations/automation.ts";
import { timeZonePromptSection } from "../../shared/timezone.ts";
import { renderUserIdentitySystemPrompt } from "../slate-user-identity.ts";
import { renderWorkflowsSystemPrompt } from "../../shared/workflow-model.ts";
import { renderChannelsSystemPrompt, type ChannelConnectionSummary } from "../channels/channel-messaging.ts";
import { renderAgentDirectorySystemPrompt, type AgentAddress, type AgentGroupAddress } from "../agents/agent-messaging.ts";
import { spotlightPromptSection } from "../../shared/slate-spotlight.ts";
import type { ConnectorManifest } from "../channels/channels.ts";

/** A rendered section, or nothing when it has nothing to say. */
function asSection(rendered: string): string | null { return rendered.length > 0 ? rendered : null; }

/** Adds a section to the prompt when it has anything to say, keeping the order it was added in. */
function appendSection(sections: string[], section: string | null | undefined): void {
  if (section != null && section.length > 0) sections.push(section);
}

export function modelVisibleLocation(location: string | null | undefined): string | null {
  return location == null ? null : toModelVisiblePath(location);
}

export interface AgentProfileForPrompt extends AgentProfileIdentity {
  readonly filePath: string;
  readonly settingsFilePath: string;
}
export interface PromptSnapshotStore {
  getAgentProfilePromptSnapshot(): AgentProfilePromptSnapshot | undefined;
  setAgentProfilePromptSnapshot(snapshot: AgentProfilePromptSnapshot): void;
}
export interface MemorySnapshotStore {
  getMemoryPromptSnapshot(): FrozenMemorySnapshot | undefined;
  setMemoryPromptSnapshot(snapshot: FrozenMemorySnapshot): void;
}
export interface MemoryPromptStore {
  recall(limit: number): MemoryRecall;
  getLocation(): string | null;
}

/** The automations a prompt may be told about, as the store answers them. */
interface AutomationSectionStore {
  getLocation(): string | null | undefined;
  list(): readonly AutomationRecord[];
  listDefinitions?(): readonly AutomationRecord[];
}

/** The workflows a prompt may point at. */
interface WorkflowSectionStore { getLocation(): string | null | undefined }

/** The channels a prompt may be told about. */
interface ChannelSectionStore {
  getLocation(): string | null | undefined;
  listConnections(): readonly ChannelConnectionSummary[];
}

/** What the platform remembers about the person this turn is for. */
interface UserMemoryRecallPort {
  recall(limits: { profileLimit: number; recentLimit: number }): { profile: readonly ProvenancedMemory[]; recent: readonly ProvenancedMemory[] };
  getLocation(): string | null
  getOwnShardLocation(): string | null
}

/** What the project this turn runs in remembers. */
interface ProjectMemoryRecallPort {
  recall(limits: { profileLimit: number; recentLimit: number }, cap: number): { injected: readonly ProjectMemoryBlock[]; alsoMemberOf: readonly { slug: string; name: string }[] };
  getLocation(): string | null
}

/** The agent name the store knows, when it knows one. */
interface AgentNameStore { getMetadata(key: string): string }

/** The request's own context: where the turn runs and who it is for. */
interface TurnRequestContext { resolve(): { readonly timeZone: string; readonly userFullName?: string } }

export interface SystemPromptAssemblyDependencies {
  /** The text the prompt is built on, and how this turn is run. */
  readonly basePrompt: string;
  readonly isSubagentRunner: boolean;
  readonly isSharedRoomRunner: boolean;
  readonly isSystemPromptOverridden: boolean;
  /** The agent's profile, as it is told to the model. */
  readonly agentProfileProvider: () => AgentProfileForPrompt | null;
  readonly agentStore: () => AgentNameStore | null;
  readonly compactionEpoch: () => number;
  /** What the platform remembers, and whether it is frozen for this turn. */
  readonly memoryStore: () => MemoryPromptStore | null;
  readonly memorySnapshots: () => MemorySnapshotStore | null;
  readonly userMemory: () => UserMemoryRecallPort | null;
  readonly projectMemory: () => ProjectMemoryRecallPort | null;
  readonly isMemoryFreezeEnabled?: () => boolean;
  /** Where this turn runs, and what it is allowed to be told. */
  readonly isBoxScopedSubagent: () => boolean;
  readonly requestContext: TurnRequestContext;
  readonly isSpotlightEnabled?: () => boolean;
  readonly isMultitaskEnabled?: () => boolean;
  readonly multitaskSection?: string;
  readonly isCloudAgentsDisabledByTeam?: () => boolean;
  /** The stores whose sections the prompt may carry. */
  readonly automationStore: () => AutomationSectionStore | null;
  readonly workflowStore: () => WorkflowSectionStore | null;
  readonly channelStore: () => ChannelSectionStore | null;
  readonly connectorManifests: readonly ConnectorManifest[];
  /** The other agents this one may be told about. */
  readonly sendToAgentImpl?: unknown;
  readonly agentManagement?: unknown;
  readonly agentDirectory?: () => readonly AgentAddress[];
  readonly agentGroups?: () => readonly AgentGroupAddress[];
  readonly agentsRootDir?: () => string | null | undefined;
  /** The MCP account sections, and the sections the runners supply themselves. */
  readonly mcpManagement: () => unknown;
  readonly isMcpMultiAccountEnabled?: () => boolean;
  readonly mcpCustomInstructionsSection: () => string | null;
  readonly mcpDiscoveryStatusSection: () => string | null;
  readonly remoteBoxSection: () => string;
  readonly computerSection: () => string | null;
}

/** The name and description lines of the profile section: what the agent is called, and what it is for. */
function profileIdentityLines(profile: AgentProfileForPrompt, sharedRoom: boolean): string[] {
  const lines: string[] = [];
  const title = profile.name.trim();
  if (title.length > 0) {
    lines.push(`Title: ${title}`);
    if (!sharedRoom) lines.push(`Your agent name is "${title}". If the user asks for your name, answer with "${title}".`);
  }
  const description = profile.description.trim();
  if (description.length > 0) lines.push(`Description: ${description}`);
  return lines;
}

function profileSection(profile: AgentProfileForPrompt | null, sharedRoom: boolean): string | null {
  if (profile == null) return null;
  const lines: string[] = [...profileIdentityLines(profile, sharedRoom), ...profileFileLines(profile, sharedRoom)];
  return lines.length === 0 ? null : ["Agent profile:", ...lines].join("\n");
}

/** Where the profile and its settings live, when the turn is not a shared room's. */
function profileFileLines(profile: AgentProfileForPrompt, sharedRoom: boolean): string[] {
  if (sharedRoom) return [];
  const lines: string[] = [];
  if (profile.filePath.length > 0) {
    lines.push(`Your profile is a JSON config file at ${toModelVisiblePath(profile.filePath)} with "name", "description", and "title" fields, which you can read with your shell tools. To rename yourself or rewrite your own description, use the update_state tool (target "profile", action "set"); it preserves every field you do not pass. Name and description edits are announced in a profile-update message for the current context and folded into this Agent profile section after the next conversation summary.`);
    lines.push(`Your profile picture is NOT part of that config \u2014 it is a conventional image file named "avatar.png" (or avatar.jpg/.jpeg/.webp/.gif/.svg) in the same directory, which you can read with your shell tools. To set it, put the image somewhere first (Shell under /workspace is fine \u2014 no CopyFromBox needed \u2014 or ${SLATE_EXTERNAL_SHELL_TOOL_NAME} on the user's computer), then call update_state (target "avatar", action "set", path=...); to go back to the default picture, update_state target "avatar", action "clear". Never change your picture unless the user asks.`);
  }
  if (profile.settingsFilePath.length > 0) {
    lines.push(`Your per-agent settings live in a separate JSON config file at ${toModelVisiblePath(profile.settingsFilePath)}, readable the same way and changed with update_state (target "settings", action "set"). "hidden_from_sidebar" (true/false) removes your own row from the user's sidebar: you stay fully functional \u2014 you keep your conversation, keep receiving messages, keep running your routines, and still accrue unread \u2014 and the user can still reach you through the Hidden chats manager and Cmd-K; the default is visible. Pass only the fields you mean to change; the rest are preserved.`);
  }
  return lines;
}

export function createSystemPromptAssembly(deps: SystemPromptAssemblyDependencies) {
  let inMemoryProfilePromptSnapshot: AgentProfilePromptSnapshot | null = null;

  /** The profile this turn is told about: the provided one, or a name the agent store knows. */
  function resolveProfileForPrompt(): AgentProfileForPrompt | null {
    const provided = deps.agentProfileProvider();
    if (provided != null) return provided;
    const store = deps.agentStore();
    if (store == null) return null;
    return { name: store.getMetadata("name"), description: "", filePath: "", settingsFilePath: "" };
  }

  /** Whether this turn prepares a profile snapshot at all: a subagent, or no profile, has none to prepare. */
  function preparesProfileSnapshot(): boolean {
    return !deps.isSubagentRunner && deps.agentProfileProvider() != null;
  }

  /** The snapshot already carried: the store's, or the one this assembly kept in memory when there is no store. */
  function carriedProfileSnapshot(store?: PromptSnapshotStore): AgentProfilePromptSnapshot | undefined {
    const persisted = store?.getAgentProfilePromptSnapshot();
    if (persisted !== undefined) return persisted;
    return store == null ? inMemoryProfilePromptSnapshot ?? undefined : undefined;
  }

  /** The profile and the section it renders as, when this turn has a profile to tell the model about. */
  function preparedProfileSection(): { profile: AgentProfileForPrompt; section: string } | null {
    const profile = resolveProfileForPrompt();
    if (profile == null) return null;
    const section = profileSection(profile, false);
    return section == null ? null : { profile, section };
  }

  function prepareAgentProfilePromptSnapshot(store?: PromptSnapshotStore): AgentProfilePromptSnapshot | undefined {
    if (!preparesProfileSnapshot()) return undefined;
    const prepared = preparedProfileSection();
    if (prepared == null) return undefined;
    const current = carriedProfileSnapshot(store);
    const resolved = resolveAgentProfilePromptSnapshot({ ...(current == null ? {} : { snapshot: current }), profileSection: prepared.section, identity: normalizeAgentProfileIdentity(prepared.profile), compactionEpoch: deps.compactionEpoch() });
    inMemoryProfilePromptSnapshot = resolved;
    if (resolved !== current) store?.setAgentProfilePromptSnapshot(resolved);
    return resolved;
  }

  /** Whether the turn's snapshot already says the same thing as the one carried, so nothing is announced. */
  function turnSnapshotIsCarried(current: AgentProfilePromptSnapshot, turnSnapshot: AgentProfilePromptSnapshot, identity: AgentProfileIdentity): boolean {
    return current.compactionEpoch === turnSnapshot.compactionEpoch
      && current.profileSection === turnSnapshot.profileSection
      && agentProfileIdentitiesEqual(current.systemIdentity, turnSnapshot.systemIdentity)
      && agentProfileIdentitiesEqual(current.announcedIdentity, identity);
  }

  function persistAnnouncedAgentProfile(store: PromptSnapshotStore | undefined, turnSnapshot: AgentProfilePromptSnapshot, identity: AgentProfileIdentity): void {
    const current = store?.getAgentProfilePromptSnapshot() ?? inMemoryProfilePromptSnapshot;
    if (current == null || turnSnapshotIsCarried(current, turnSnapshot, identity)) return;
    const next = { ...current, announcedIdentity: identity };
    inMemoryProfilePromptSnapshot = next; store?.setAgentProfilePromptSnapshot(next);
  }

  /** The profile-update message this turn owes, when the profile changed since it was last announced. */
  function getAgentProfileUpdateForTurn(snapshot?: AgentProfilePromptSnapshot): { text: string; identity: AgentProfileIdentity } | null {
    const profile = deps.agentProfileProvider();
    if (snapshot == null || profile == null) return null;
    const identity = normalizeAgentProfileIdentity(profile);
    if (agentProfileIdentitiesEqual(identity, snapshot.announcedIdentity)) return null;
    return { text: renderAgentProfileUpdate(identity), identity };
  }

  /** The user-memory part: what the platform remembers about the person, when it has anything. */
  function userMemoryPart(): { rendered: string; hasFacts: boolean } {
    const userMemory = deps.userMemory();
    if (userMemory == null) return { rendered: "", hasFacts: false };
    const recall = userMemory.recall({ profileLimit: 50, recentLimit: 15 });
    const rendered = renderUserMemorySystemPrompt(recall, { ...(modelVisibleLocation(userMemory.getLocation()) == null ? {} : { userMemoryDir: modelVisibleLocation(userMemory.getLocation())! }), ...(modelVisibleLocation(userMemory.getOwnShardLocation()) == null ? {} : { ownShardDir: modelVisibleLocation(userMemory.getOwnShardLocation())! }) });
    return { rendered, hasFacts: recall.profile.length > 0 || recall.recent.length > 0 };
  }

  /** The project-memory part: what the project remembers, when it has anything. */
  function projectMemoryPart(): { rendered: string; hasFacts: boolean } {
    const projectMemory = deps.projectMemory();
    if (projectMemory == null) return { rendered: "", hasFacts: false };
    const recall = projectMemory.recall({ profileLimit: 25, recentLimit: 10 }, 3);
    const root = modelVisibleLocation(projectMemory.getLocation());
    const injected = recall.injected.map((block) =>
      block.ownShardDir == null ? block : { ...block, ownShardDir: toModelVisiblePath(block.ownShardDir) });
    const rendered = renderProjectMemorySystemPrompt({ ...recall, injected }, root == null ? {} : { projectsRootDir: root });
    return { rendered, hasFacts: projectMemoryHasFacts(recall) };
  }

  /** The live memory section: the person's, the project's and the agent's own, in that order. */
  function renderLiveMemory(store: MemoryPromptStore): { render: string; hasFacts: boolean } {
    const recall = store.recall(30);
    const parts: string[] = [];
    let hasFacts = recall.profile.length > 0 || recall.recent.length > 0;
    for (const part of [userMemoryPart(), projectMemoryPart()]) {
      if (part.rendered.length > 0) parts.push(part.rendered);
      hasFacts ||= part.hasFacts;
    }
    const agent = renderMemorySystemPrompt(recall, modelVisibleLocation(store.getLocation()) ?? undefined);
    if (agent.length > 0) parts.push(agent);
    return { render: parts.join("\n\n"), hasFacts };
  }

  /** The memory section resolved against a frozen snapshot, reusing it until the compaction epoch moves. */
  function frozenMemorySection(snapshots: NonNullable<ReturnType<SystemPromptAssemblyDependencies["memorySnapshots"]>>, renderLive: () => { render: string; hasFacts: boolean }): string | null {
    const frozen = snapshots.getMemoryPromptSnapshot();
    const resolved = resolveFrozenMemoryPrompt({ ...(frozen == null ? {} : { snapshot: frozen }), compactionEpoch: deps.compactionEpoch(), renderLive });
    if (resolved.snapshotToPersist != null) snapshots.setMemoryPromptSnapshot(resolved.snapshotToPersist);
    return asSection(resolved.render);
  }

  function getMemorySection(): string | null {
    const store = deps.memoryStore();
    if (store == null) return null;
    const renderLive = () => renderLiveMemory(store);
    const snapshots = deps.memorySnapshots();
    if (snapshots == null || (deps.isMemoryFreezeEnabled?.() ?? isMemoryFreezeEnabled()) === false) return asSection(renderLive().render);
    return frozenMemorySection(snapshots, renderLive);
  }

  /** The automations a prompt shows: the definitions when the store keeps them apart, else every automation. */
  function automationsForPrompt(store: ReturnType<SystemPromptAssemblyDependencies["automationStore"]> & object): readonly AutomationRecord[] {
    return (store.listDefinitions?.() ?? store.list()).slice(0, 100);
  }

  function getAutomationsSection(): string | null {
    const store = deps.automationStore();
    if (store == null) return null;
    return asSection(renderAutomationsSystemPrompt(automationsForPrompt(store), modelVisibleLocation(store.getLocation()), deps.requestContext.resolve().timeZone));
  }

  function getWorkflowsSection(): string | null {
    const store = deps.workflowStore();
    if (store == null) return null;
    const rendered = renderWorkflowsSystemPrompt(modelVisibleLocation(store.getLocation()));
    return asSection(rendered);
  }

  /** The channel connections the platform has a manifest for, in the store's order. */
  function enabledChannelConnections(store: ReturnType<SystemPromptAssemblyDependencies["channelStore"]> & object): readonly ChannelConnectionSummary[] {
    const enabledPlatforms = new Set(deps.connectorManifests.map((manifest) => manifest.platform));
    return store.listConnections().filter((connection) => enabledPlatforms.has(connection.platform));
  }

  function getChannelsSection(): string | null {
    const store = deps.channelStore();
    if (store == null) return null;
    return asSection(renderChannelsSystemPrompt(deps.connectorManifests, enabledChannelConnections(store), modelVisibleLocation(store.getLocation())));
  }

  /** Whether this turn is told about the other agents it can reach. */
  function showsAgentDirectory(): boolean {
    if (deps.isSubagentRunner) return false;
    return deps.sendToAgentImpl != null || deps.agentManagement != null;
  }

  function getAgentDirectorySection(): string | null {
    if (!showsAgentDirectory()) return null;
    return asSection(renderAgentDirectorySystemPrompt(deps.agentDirectory?.() ?? [], deps.agentGroups?.() ?? [], modelVisibleLocation(deps.agentsRootDir?.()) ?? undefined));
  }

  /** The sections a turn's prompt carries beyond its base, in the order the model reads them. */
  function promptParts(cloudDisabled: boolean): Array<() => string | null | undefined> {
    return [
      () => asSection(renderUserIdentitySystemPrompt(deps.requestContext.resolve().userFullName)),
      () => (deps.isSubagentRunner || deps.isSystemPromptOverridden || deps.isMultitaskEnabled?.() !== true ? undefined : deps.multitaskSection),
      () => (!deps.isSystemPromptOverridden || deps.isSubagentRunner || !cloudDisabled ? undefined : SLATE_CLOUD_AGENTS_DISABLED_PROMPT_SECTION),
      () => (deps.isSubagentRunner || deps.mcpManagement() == null || deps.isMcpMultiAccountEnabled?.() !== true ? undefined : SLATE_MCP_MULTI_ACCOUNT_PROMPT_SECTION),
      () => (deps.isBoxScopedSubagent() ? null : asSection(timeZonePromptSection(deps.requestContext.resolve().timeZone))),
      getMemorySection,
      getAutomationsSection,
      getWorkflowsSection,
      getChannelsSection,
      getAgentDirectorySection,
      () => [deps.mcpCustomInstructionsSection(), deps.mcpDiscoveryStatusSection(), deps.remoteBoxSection(), deps.computerSection()].filter((section) => section != null && section.length > 0).join("\n\n"),
    ];
  }

  /** The paragraphs every turn's prompt starts from: the base, and the spotlight when it applies. */
  function openingSections(cloudDisabled: boolean): string[] {
    const base = !deps.isSystemPromptOverridden && cloudDisabled ? SLATE_SYSTEM_PROMPT_CLOUD_AGENTS_DISABLED : deps.basePrompt;
    const sections = [base];
    if (deps.isSpotlightEnabled?.() !== false) sections.push(spotlightPromptSection({ canSendMessage: !deps.isSubagentRunner }));
    return sections;
  }

  /** The prompt a turn is given: the opening paragraphs, then its profile section and, unless it is a shared room, the parts it calls for. */
  function composePrompt(cloudDisabled: boolean, sharedRoom: boolean, snapshot?: AgentProfilePromptSnapshot): string {
    const sections = openingSections(cloudDisabled);
    appendSection(sections, sharedRoom ? profileSection(resolveProfileForPrompt(), true) : snapshot?.profileSection ?? profileSection(resolveProfileForPrompt(), false));
    if (!sharedRoom) for (const part of promptParts(cloudDisabled)) appendSection(sections, part());
    return sections.join("\n\n");
  }

  function getSystemPrompt(snapshot?: AgentProfilePromptSnapshot): string {
    return composePrompt(deps.isCloudAgentsDisabledByTeam?.() === true, deps.isSharedRoomRunner, snapshot);
  }

  return {
    getSystemPrompt, prepareAgentProfilePromptSnapshot, getAgentProfileUpdateForTurn, persistAnnouncedAgentProfile,
    resetProfileSnapshotFallback() { inMemoryProfilePromptSnapshot = null; },
  };
}
