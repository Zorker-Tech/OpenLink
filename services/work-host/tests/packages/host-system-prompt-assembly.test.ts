import { test } from "node:test"
import assert from "node:assert/strict"

import { createSystemPromptAssembly, modelVisibleLocation, type SystemPromptAssemblyDependencies } from "../../source/host/runner/system-prompt-assembly.ts"
import { spotlightPromptSection } from "../../source/shared/slate-spotlight.ts"
import { timeZonePromptSection } from "../../source/shared/timezone.ts"
import { renderUserIdentitySystemPrompt } from "../../source/host/slate-user-identity.ts"
import { SLATE_CLOUD_AGENTS_DISABLED_PROMPT_SECTION, SLATE_MCP_MULTI_ACCOUNT_PROMPT_SECTION, SLATE_SYSTEM_PROMPT_CLOUD_AGENTS_DISABLED } from "../../source/host/runner/system-prompt.ts"
import { renderChannelsSystemPrompt } from "../../source/host/channels/channel-messaging.ts"

const profile = { name: "Profile Name", description: "does things", filePath: "/agents/a/profile.json", settingsFilePath: "/agents/a/settings.json" }

const deps = (overrides: Partial<SystemPromptAssemblyDependencies> = {}): SystemPromptAssemblyDependencies => ({
  basePrompt: "BASE PROMPT",
  isSubagentRunner: false,
  isSharedRoomRunner: false,
  isSystemPromptOverridden: false,
  agentProfileProvider: () => null,
  agentStore: () => null,
  compactionEpoch: () => 0,
  memoryStore: () => null,
  memorySnapshots: () => null,
  userMemory: () => null,
  projectMemory: () => null,
  isBoxScopedSubagent: () => false,
  requestContext: { resolve: () => ({ timeZone: "UTC", userFullName: "Someone" }) },
  automationStore: () => null,
  workflowStore: () => null,
  channelStore: () => null,
  connectorManifests: [],
  mcpManagement: () => null,
  mcpCustomInstructionsSection: () => null,
  mcpDiscoveryStatusSection: () => null,
  remoteBoxSection: () => "",
  computerSection: () => null,
  ...overrides,
})

test("a plain turn's prompt is the base plus the sections that have something to say, in order", () => {
  const prompt = createSystemPromptAssembly(deps()).getSystemPrompt()
  assert.deepEqual(prompt.split("\n\n"), [
    "BASE PROMPT",
    spotlightPromptSection({ canSendMessage: true }),
    renderUserIdentitySystemPrompt("Someone"),
    timeZonePromptSection("UTC"),
  ])
  // A box-scoped subagent is not told the time zone, and nothing empty is appended.
  const boxed = createSystemPromptAssembly(deps({ isBoxScopedSubagent: () => true })).getSystemPrompt()
  assert.deepEqual(boxed.split("\n\n"), ["BASE PROMPT", spotlightPromptSection({ canSendMessage: true }), renderUserIdentitySystemPrompt("Someone")])
  // The spotlight is left out when the turn says so.
  const unlit = createSystemPromptAssembly(deps({ isSpotlightEnabled: () => false })).getSystemPrompt()
  assert.deepEqual(unlit.split("\n\n"), ["BASE PROMPT", renderUserIdentitySystemPrompt("Someone"), timeZonePromptSection("UTC")])
})

test("the team's own prompt replaces the base when its cloud agents are disabled", () => {
  assert.equal(createSystemPromptAssembly(deps({ isCloudAgentsDisabledByTeam: () => true })).getSystemPrompt().startsWith(SLATE_SYSTEM_PROMPT_CLOUD_AGENTS_DISABLED + "\n\n"), true)
  const overridden = createSystemPromptAssembly(deps({ isSystemPromptOverridden: true, isCloudAgentsDisabledByTeam: () => true })).getSystemPrompt()
  assert.equal(overridden.startsWith("BASE PROMPT\n\n"), true, "an overridden prompt stays the runner's own")
  assert.equal(overridden.includes(SLATE_CLOUD_AGENTS_DISABLED_PROMPT_SECTION), true, "and is told why cloud agents are unavailable")
})

test("the parts a turn calls for are included only when they apply, in the order they are read", () => {
  const prompt = createSystemPromptAssembly(deps({
    isMultitaskEnabled: () => true,
    multitaskSection: "MULTITASK",
    mcpManagement: () => ({}),
    isMcpMultiAccountEnabled: () => true,
    mcpCustomInstructionsSection: () => "MCP CUSTOM",
    mcpDiscoveryStatusSection: () => "MCP STATUS",
    remoteBoxSection: () => "REMOTE BOX",
    computerSection: () => "COMPUTER",
  })).getSystemPrompt()
  const indexes = ["MULTITASK", "MCP CUSTOM", "MCP STATUS", "REMOTE BOX", "COMPUTER"].map((marker) => prompt.indexOf(marker))
  assert.equal(indexes.every((index) => index >= 0), true)
  assert.deepEqual([...indexes].sort((a, b) => a - b), indexes, "the parts come in the order the model reads them")
  // A subagent has no multitask section; a multi-account flag without management has no section either.
  assert.equal(createSystemPromptAssembly(deps({ isSubagentRunner: true, isMultitaskEnabled: () => true, multitaskSection: "MULTITASK" })).getSystemPrompt().includes("MULTITASK"), false)
  assert.equal(createSystemPromptAssembly(deps({ isMcpMultiAccountEnabled: () => true })).getSystemPrompt().includes(SLATE_MCP_MULTI_ACCOUNT_PROMPT_SECTION), false, "a flag without management has no section")
  assert.equal(prompt.includes(SLATE_MCP_MULTI_ACCOUNT_PROMPT_SECTION), true)
  // The runner's own sections are separated like every other section.
  assert.equal(prompt.includes("MCP CUSTOM\n\nMCP STATUS"), true)
  assert.equal(prompt.includes("MCP STATUS\n\nREMOTE BOX"), true)
  // A subagent is not told about the other agents, even when it could reach them.
  const subagent = deps({ isSubagentRunner: true, sendToAgentImpl: {}, agentDirectory: () => [{ id: "b", name: "B" }] })
  assert.deepEqual(createSystemPromptAssembly(subagent).getSystemPrompt(), createSystemPromptAssembly(deps({ isSubagentRunner: true })).getSystemPrompt())
  // A channel the platform has no manifest for is not shown.
  const slack = { platform: "slack", label: "team", status: "connected" }
  const channelStore = { getLocation: () => "/agents/a/channels", listConnections: () => [slack, { platform: "other", label: "other-conn-label", status: "connected" }] }
  const channelPrompt = createSystemPromptAssembly(deps({ channelStore: () => channelStore, connectorManifests: [{ platform: "slack" } as never] })).getSystemPrompt()
  assert.equal(channelPrompt.includes(renderChannelsSystemPrompt([{ platform: "slack" } as never], [slack], "/agents/a/channels")), true)
  assert.equal(channelPrompt.includes("other-conn-label"), false, "the connection without a manifest is left out")
})

test("a shared room's prompt is the opening paragraphs and its own profile, and nothing else", () => {
  const prompt = createSystemPromptAssembly(deps({ isSharedRoomRunner: true, agentProfileProvider: () => profile, isMultitaskEnabled: () => true, multitaskSection: "MULTITASK", computerSection: () => "COMPUTER" })).getSystemPrompt()
  const parts = prompt.split("\n\n")
  assert.equal(parts[0], "BASE PROMPT")
  assert.equal(parts[1], spotlightPromptSection({ canSendMessage: true }))
  assert.equal(parts[2]?.startsWith("Agent profile:"), true)
  assert.equal(parts[2]?.includes("Profile Name"), true)
  assert.equal(prompt.includes("does things"), true, "a shared room is told the description")
  assert.equal(prompt.includes(renderUserIdentitySystemPrompt("Someone")), false, "but not the rest of the sections")
  assert.equal(prompt.includes("COMPUTER"), false)
  assert.equal(prompt.includes("Your profile is a JSON config file"), false, "and not where the profile file is")
})

test("the profile snapshot is prepared once, announced once, and reset on request", () => {
  const assembly = createSystemPromptAssembly(deps({ agentProfileProvider: () => profile }))
  const prepared = assembly.prepareAgentProfilePromptSnapshot()
  assert.equal(prepared?.profileSection.includes("Profile Name"), true)
  const store = { snapshot: undefined as unknown, getAgentProfilePromptSnapshot() { return this.snapshot as never }, setAgentProfilePromptSnapshot(next: unknown) { this.snapshot = next } }
  const stored = assembly.prepareAgentProfilePromptSnapshot(store)
  assert.equal(store.snapshot, stored, "the snapshot is kept for the next turn")
  assert.equal(assembly.persistAnnouncedAgentProfile(store, stored!, stored!.systemIdentity), undefined)
  assert.deepEqual((store.snapshot as { announcedIdentity: unknown }).announcedIdentity, stored!.systemIdentity, "the announcement is carried to the next turn")
  assert.equal(assembly.prepareAgentProfilePromptSnapshot() !== undefined, true, "a snapshot can still be prepared after reset")
  // A frozen flag switched off keeps the live rendering, which never persists a snapshot.
  let persisted = 0
  const livePrompt = createSystemPromptAssembly(deps({
    memoryStore: () => ({ recall: () => ({ profile: [{ text: "p", provenance: "x" }], recent: [] }), getLocation: () => "/agents/a/memory" }) as never,
    memorySnapshots: () => ({ getMemoryPromptSnapshot: () => undefined, setMemoryPromptSnapshot: () => { persisted += 1 } }),
    isMemoryFreezeEnabled: () => false,
  })).getSystemPrompt()
  assert.equal(livePrompt.includes("p"), true, "the live memory is rendered")
  assert.equal(persisted, 0, "and no frozen snapshot is written")
  assembly.resetProfileSnapshotFallback()
  assert.equal(createSystemPromptAssembly(deps({ isSubagentRunner: true, agentProfileProvider: () => profile })).prepareAgentProfilePromptSnapshot(), undefined, "a subagent prepares none")
})

test("a profile update is owed when the profile changed since the last announcement", () => {
  let name = "First"
  let modelProfile = { ...profile, name }
  const assembly = createSystemPromptAssembly(deps({ agentProfileProvider: () => modelProfile }))
  const snapshot = assembly.prepareAgentProfilePromptSnapshot()
  assert.equal(assembly.getAgentProfileUpdateForTurn(snapshot), null, "nothing is owed for the profile already announced")
  modelProfile = { ...profile, name: "Second" }
  const next = assembly.prepareAgentProfilePromptSnapshot()
  const update = next == null ? null : assembly.getAgentProfileUpdateForTurn(next)
  assert.equal(update == null, false)
  assert.equal(update?.text.includes("Second"), true)
})

test("a path is only made model-visible when there is one", () => {
  assert.equal(modelVisibleLocation(null), null)
  assert.equal(modelVisibleLocation(undefined), null)
  assert.equal(modelVisibleLocation("/agents/a"), modelVisibleLocation("/agents/a"))
})
