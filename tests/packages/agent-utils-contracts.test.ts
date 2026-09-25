import { test } from "node:test"
import assert from "node:assert/strict"

import { createContext } from "../../source/packages/context/context.ts"
import { PrivacyMode } from "../../source/packages/proto/generated/aiserver/v1/privacy_mode_pb.ts"
import { BackgroundComposerSource } from "../../source/packages/proto/generated/aiserver/v1/background_composer_pb.ts"
import { AgentMode } from "../../source/packages/proto/generated/agent/v1/agent_pb.ts"
import { InMemoryBlobStore } from "../../source/packages/agent-kv/blob-store.ts"
import { toHex } from "../../source/packages/agent-kv/serde.ts"
import {
  AgentType,
  classifierResultToProto,
  isCloudAgentComputerUseEligibleEnvironment,
  isComputerUseEligibleModel,
  shouldEnableComputerUse,
  shouldUseExperimentalCloudBehavior,
} from "../../source/packages/agent/utils/agent-config.ts"
import {
  getContextUsageInfo,
  getFilenameWithoutExtension,
  getFirstNonEmptyLine,
  getSkillSourceFromPath,
  isHookStepConfigured,
} from "../../source/packages/agent/utils/common-helpers.ts"
import { agentEventTrackerKey, getAgentEventTracker, recordSkillApplied, type AgentEventTracker } from "../../source/packages/agent/utils/event-tracking.ts"
import { isLoopbackIpHost, isPrivateIpHost } from "../../source/packages/agent/utils/ip-addresses.ts"
import { projectPermissionsAutoRunFromProto, smartModeAutoRunInstructionsFromProtos } from "../../source/packages/agent/utils/permissions-instructions.ts"
import { isRootProjectUserMessage, resolveProjectConversationContext, shouldOmitCloudWorkerProcedure } from "../../source/packages/agent/utils/project-conversation.ts"
import { extractCompleteTagRanges, extractMcpServerTagRanges, extractSelfClosingTagRangesMatching } from "../../source/packages/agent/utils/prompt-tags.ts"
import {
  createSubagentContext,
  getAutoRoutingReasonFromContext,
  getClientOsMetricTagFromContext,
  getClientVersionMetricTagsFromContext,
  getConversationGroupId,
  getIsInternalTeamFromContext,
  getIsSubagentFromContext,
  getRequestId,
  getRootParentRequestId,
  getSdkFlavorMetricTagFromContext,
  clientOsKey,
  clientVersionKey,
  conversationIdKey,
  membershipTypeKey,
  requestIdKey,
  teamIdKey,
  getMembershipTypeMetricTagsFromContext,
} from "../../source/packages/agent/utils/request-scope.ts"
import { filterByActorIdentity, getEffectiveScopedTo, parseScopedToFromFrontmatter } from "../../source/packages/agent/utils/rule-scoping.ts"
import { isFileScopedRule } from "../../source/packages/agent/utils/rule-matching.ts"
import { persistPromptContextUsageSnapshot } from "../../source/packages/agent/utils/usage-snapshot.ts"

test("file, line and context helpers answer the questions the prompt assembly asks", () => {
  assert.equal(getFilenameWithoutExtension("/a/b/rule.mdc"), "rule")
  assert.equal(getFilenameWithoutExtension("/a/b/rule.md"), "rule.md")
  assert.equal(getFilenameWithoutExtension("rule"), "rule")
  assert.equal(getFilenameWithoutExtension("C:\\a\\b\\rule.mdc"), "rule")
  assert.equal(getFirstNonEmptyLine("\n\n  title  \nbody"), "  title  ")
  assert.equal(getFirstNonEmptyLine(""), "")
  assert.deepEqual(getContextUsageInfo({ maxTokens: 200, usedTokens: 50 }), {
    contextWindowSize: 200,
    contextTokens: 50,
    contextUsagePercent: 25,
  })
  assert.equal(getContextUsageInfo({ maxTokens: 0, usedTokens: 10 }).contextUsagePercent, 0)
  assert.equal(isHookStepConfigured(["pre"], "pre"), true)
  assert.equal(isHookStepConfigured(undefined, "pre"), false)
})

test("a skill's source decides whether the user may change it", () => {
  assert.equal(getSkillSourceFromPath("/home/u/.slate/skills-builtin/x/SKILL.md"), "builtin")
  assert.equal(getSkillSourceFromPath("/home/u/.slate/plugins/p/x/SKILL.md"), "plugin")
  assert.equal(getSkillSourceFromPath("/home/u/.slate/skills/x/SKILL.md"), "workspace")
  assert.equal(getSkillSourceFromPath("/home/u/.agents/skills/x/SKILL.md"), "workspace")
  assert.equal(getSkillSourceFromPath("/home/u/.slate/skills-builtin\\x\\SKILL.md"), "builtin")
  assert.equal(getSkillSourceFromPath("/home/u/random/SKILL.md"), "unknown")
})

test("loopback and private hosts are recognized in both address families", () => {
  assert.equal(isLoopbackIpHost("127.0.0.1"), true)
  assert.equal(isLoopbackIpHost("127.9.9.9"), true)
  assert.equal(isLoopbackIpHost("::1"), true)
  assert.equal(isLoopbackIpHost("::ffff:127.0.0.1"), true)
  assert.equal(isLoopbackIpHost("8.8.8.8"), false)
  assert.equal(isLoopbackIpHost("example.com"), false, "a hostname is not an address")

  assert.equal(isPrivateIpHost("10.0.0.5"), true)
  assert.equal(isPrivateIpHost("192.168.1.1"), true)
  assert.equal(isPrivateIpHost("172.16.0.1"), true)
  assert.equal(isPrivateIpHost("172.32.0.1"), false)
  assert.equal(isPrivateIpHost("169.254.1.1"), true)
  assert.equal(isPrivateIpHost("0.0.0.0"), true)
  assert.equal(isPrivateIpHost("fc00::1"), true)
  assert.equal(isPrivateIpHost("fe80::1"), true)
  assert.equal(isPrivateIpHost("::ffff:10.0.0.1"), true)
  assert.equal(isPrivateIpHost("2001:4860:4860::8888"), false)
})

test("rule scoping reads the two frontmatter shapes people write", () => {
  const inline = "---\nmetadata.scopedTo: [ada@example.com, Grace@Example.com]\n---\nbody"
  assert.deepEqual(parseScopedToFromFrontmatter(inline), ["ada@example.com", "Grace@Example.com"])

  const scalar = "---\nmetadata.scopedTo: 'ada@example.com'\n---\nbody"
  assert.deepEqual(parseScopedToFromFrontmatter(scalar), ["ada@example.com"])

  const nested = "---\nmetadata:\n  scopedTo:\n    - ada@example.com\n    - grace@example.com\n---\nbody"
  assert.deepEqual(parseScopedToFromFrontmatter(nested), ["ada@example.com", "grace@example.com"])

  assert.deepEqual(parseScopedToFromFrontmatter("---\nmetadata:\n  scopedTo: ada@example.com\n---\nbody"), ["ada@example.com"])
  assert.deepEqual(parseScopedToFromFrontmatter("no frontmatter"), [])
  assert.deepEqual(parseScopedToFromFrontmatter("---\nother: 1\n---\nbody"), [])
  assert.deepEqual(parseScopedToFromFrontmatter("---\nmetadata:\n  scopedTo: []\n---\nbody"), [])

  assert.deepEqual(getEffectiveScopedTo({ scopedTo: ["a@b.c"] }), ["a@b.c"])
  assert.deepEqual(getEffectiveScopedTo({ frontmatter: inline }), ["ada@example.com", "Grace@Example.com"])
  assert.deepEqual(getEffectiveScopedTo({ content: inline }), ["ada@example.com", "Grace@Example.com"])
  assert.deepEqual(getEffectiveScopedTo({}), [])
})

test("scoped rules are filtered by who is asking, and unscoped rules always apply", () => {
  const items = [
    { name: "everyone" },
    { name: "ada", frontmatter: "---\nmetadata.scopedTo: [ada@example.com]\n---\n" },
    { name: "grace", scopedTo: ["grace@example.com"] },
  ]
  assert.deepEqual(filterByActorIdentity(items, { email: "ada@example.com" }).map(item => item.name), ["everyone", "ada"])
  assert.deepEqual(filterByActorIdentity(items, { email: "ADA@EXAMPLE.COM" }).map(item => item.name), ["everyone", "ada"])
  assert.deepEqual(filterByActorIdentity(items, undefined).map(item => item.name), ["everyone"])
})

test("prompt tags are found even when an attribute holds a bracket", () => {
  const prompt = '<section title="a > b">one</section><other>two</other><x/>'
  assert.deepEqual(
    extractCompleteTagRanges(prompt, "section").map(range => prompt.slice(range.start, range.end)),
    ['<section title="a > b">one</section>'],
  )
  assert.deepEqual(extractCompleteTagRanges(prompt, "missing"), [])
  assert.deepEqual(
    extractSelfClosingTagRangesMatching(prompt, name => name === "x").map(range => prompt.slice(range.start, range.end)),
    ["<x/>"],
  )

  const mcp = '<mcp_file_system_server name="a">body</mcp_file_system_server><namespace />'
  assert.deepEqual(extractMcpServerTagRanges(mcp).map(range => range.tagName), ["namespace", "mcp_file_system_server"])
  assert.deepEqual(extractMcpServerTagRanges("nothing here"), [])
})

test("a classification result becomes the proto the client reads", () => {
  const success = classifierResultToProto({
    kind: "classification-succeeded",
    suggestedSandboxMode: "SANDBOX",
    commands: [{ name: "ls", arguments: ["-l"], suggestedAllowlistEntry: "ls -l", subcommandTokens: ["ls"] }],
  })
  assert.equal(success.classificationFailed, false)
  assert.equal(success.commands.length, 1)
  assert.equal(success.commands[0]?.name, "ls")

  const other = classifierResultToProto({ kind: "classification-succeeded", suggestedSandboxMode: "NO_SANDBOX", commands: [] })
  assert.equal(other.suggestedSandboxMode, 2, "NO_SANDBOX")
  const undetermined = classifierResultToProto({ kind: "classification-succeeded", suggestedSandboxMode: "?", commands: [] })
  assert.equal(undetermined.suggestedSandboxMode, 3, "an unknown mode is undetermined")

  const failed = classifierResultToProto({ kind: "classification-failed" })
  assert.equal(failed.classificationFailed, true)
  assert.deepEqual(failed.commands, [])
})

test("computer use is enabled only where it makes sense", () => {
  assert.equal(isComputerUseEligibleModel("claude-4.5-sonnet"), true)
  assert.equal(isComputerUseEligibleModel("claude-4.5-sonnet-20250101"), true)
  assert.equal(isComputerUseEligibleModel("claude-4.5-sonnetx"), false)
  assert.equal(isComputerUseEligibleModel("some-other-model"), false)

  assert.equal(isCloudAgentComputerUseEligibleEnvironment(BackgroundComposerSource.GITHUB_CI_AUTOFIX), false)
  assert.equal(isCloudAgentComputerUseEligibleEnvironment(undefined), true)
  assert.equal(shouldUseExperimentalCloudBehavior({ agentType: AgentType.BACKGROUND, enableCloudTesting: true }), true)
  assert.equal(shouldUseExperimentalCloudBehavior({ agentType: AgentType.IDE, enableCloudTesting: true }), false)

  const eligible = {
    agentType: AgentType.BACKGROUND,
    isBackground: true,
    enableCloudTesting: true,
    backgroundAgentSource: undefined,
    modelId: "claude-4.5-sonnet",
  }
  assert.equal(shouldEnableComputerUse(eligible), true)
  assert.equal(shouldEnableComputerUse({ ...eligible, isBackground: false }), false)
  assert.equal(shouldEnableComputerUse({ ...eligible, modelId: "other" }), false)
  assert.equal(
    shouldEnableComputerUse({ ...eligible, backgroundAgentSource: BackgroundComposerSource.BUGBOT_AUTOFIX }),
    false,
  )
})

test("a subagent runs as its own request with its parent recorded", () => {
  const root = createContext().with(requestIdKey, "root-1").with(conversationIdKey, "conv-1")
  const subagent = createSubagentContext(root, "sub-1", "call-9")

  assert.equal(getRequestId(subagent), "sub-1")
  assert.equal(getRootParentRequestId(subagent), "root-1")
  assert.equal(getIsSubagentFromContext(subagent), true)
  assert.equal(getIsSubagentFromContext(root), false)
  assert.equal(getConversationGroupId(subagent), "conv-1", "a subagent stays in its conversation group")

  const nested = createSubagentContext(subagent, "sub-2", "call-10")
  assert.equal(getRootParentRequestId(nested), "root-1", "the root is carried, not re-derived")

  const grouped = root.with(conversationIdKey, "conv-1").with({ symbol: Symbol("conversationGroupId"), defaultValue: undefined }, "group-1")
  void grouped
})

test("client metric tags are normalized and bounded", () => {
  assert.deepEqual(getClientVersionMetricTagsFromContext(createContext()), { clientversion: "unknown", clienttype: "unknown" })
  const versioned = createContext().with(clientVersionKey, "sdk-python-1.2.3")
  assert.deepEqual(getClientVersionMetricTagsFromContext(versioned), { clientversion: "1.2.3", clienttype: "unknown" })
  const weird = createContext().with(clientVersionKey, "not-a-version")
  assert.equal(getClientVersionMetricTagsFromContext(weird).clientversion, "unknown")

  assert.deepEqual(getSdkFlavorMetricTagFromContext(createContext().with(clientVersionKey, "sdk-python-1.2.3")), { sdkflavor: "python" })
  assert.deepEqual(getSdkFlavorMetricTagFromContext(createContext().with(clientVersionKey, "sdk-1.2.3")), { sdkflavor: "ts" })
  assert.deepEqual(getSdkFlavorMetricTagFromContext(createContext()), { sdkflavor: "none" })

  assert.deepEqual(getClientOsMetricTagFromContext(createContext().with(clientOsKey, "Windows")), { os: "win32" })
  assert.deepEqual(getClientOsMetricTagFromContext(createContext().with(clientOsKey, "plan9")), { os: "other" })
  assert.deepEqual(getClientOsMetricTagFromContext(createContext()), { os: "unknown" })

  assert.deepEqual(getMembershipTypeMetricTagsFromContext(createContext().with(membershipTypeKey, "pro")), { membershiptype: "pro" })
  assert.equal(getIsInternalTeamFromContext(createContext().with(teamIdKey, 1)), true)
  assert.equal(getIsInternalTeamFromContext(createContext().with(teamIdKey, 2)), false)
  assert.equal(getAutoRoutingReasonFromContext(createContext()), "unknown")
})

test("empty permission entries are dropped, and an administrator's layer wins", () => {
  assert.equal(projectPermissionsAutoRunFromProto(undefined), undefined)
  assert.equal(projectPermissionsAutoRunFromProto({ allowInstructions: [], blockInstructions: [] }), undefined)
  assert.equal(projectPermissionsAutoRunFromProto({ allowInstructions: [""], blockInstructions: [] }), undefined)
  assert.deepEqual(
    projectPermissionsAutoRunFromProto({ allowInstructions: ["a", ""], blockInstructions: ["b"] }),
    { allowInstructions: ["a"], blockInstructions: ["b"] },
  )

  const admin = smartModeAutoRunInstructionsFromProtos({
    userPermissionsAutoRun: { allowInstructions: ["user"], blockInstructions: [] },
    adminPermissionsAutoRun: { allowInstructions: ["admin"], blockInstructions: [] },
  })
  assert.equal(admin.hasAdminOverride, true)
  assert.deepEqual(admin.projectAutoRunInstructions?.allowInstructions, ["admin"])
  assert.equal(admin.userAutoRunInstructions, undefined, "an administrator's layer replaces the user's")

  const layered = smartModeAutoRunInstructionsFromProtos({
    userPermissionsAutoRun: { allowInstructions: ["user"], blockInstructions: [] },
    projectPermissionsAutoRun: { allowInstructions: ["project"], blockInstructions: [] },
  })
  assert.equal(layered.hasAdminOverride, false)
  assert.deepEqual(layered.userAutoRunInstructions?.allowInstructions, ["user"])
  assert.deepEqual(layered.projectAutoRunInstructions?.allowInstructions, ["project"])
})

test("event reporting goes to the tracker the context carries, and nowhere by default", () => {
  const ctx = createContext()
  assert.doesNotThrow(() => recordSkillApplied(ctx, { skillId: "s", skillSource: "workspace", entrypoint: "tool" }))

  const seen: unknown[] = []
  const tracker: AgentEventTracker = {
    ...getAgentEventTracker(ctx),
    trackSkillApplied: (_context, event) => { seen.push(event) },
  }
  const recording = createContext().with(agentEventTrackerKey, tracker)
  recordSkillApplied(recording, { skillId: "s", skillSource: "workspace", entrypoint: "manually_attached" })
  recordSkillApplied(recording, { skillId: "t", skillSource: "workspace", entrypoint: "tool", stateHandler: { lastSkillCatalogBudgetStrategy: "truncated" } })
  assert.deepEqual(seen.map(event => (event as { skillId: string }).skillId), ["s", "t"])
})

test("a usage snapshot is written once per prompt, and not at all without storage", async () => {
  const blobStore = new InMemoryBlobStore()
  const ctx = createContext()
  const tree = { _privacyMode: PrivacyMode.USAGE_DATA_TRAINING_ALLOWED, schemaVersion: 1, nodes: [] }
  const messages = [new Uint8Array([1, 2, 3])]

  const first = await persistPromptContextUsageSnapshot({
    blobStore, ctx, privacyMode: PrivacyMode.USAGE_DATA_TRAINING_ALLOWED, rootPromptMessagesJson: messages, usageTree: tree,
  })
  assert.ok(first)
  const stored = await blobStore.getBlob(ctx, first)
  assert.ok(stored && stored.byteLength > 0)

  const again = await persistPromptContextUsageSnapshot({
    blobStore, ctx, privacyMode: PrivacyMode.USAGE_DATA_TRAINING_ALLOWED, rootPromptMessagesJson: messages, usageTree: tree,
  })
  assert.equal(toHex(again as Uint8Array), toHex(first), "unchanged messages reuse the snapshot")

  const changed = await persistPromptContextUsageSnapshot({
    blobStore, ctx, privacyMode: PrivacyMode.USAGE_DATA_TRAINING_ALLOWED, rootPromptMessagesJson: [new Uint8Array([9])], usageTree: tree,
  })
  assert.notEqual(toHex(changed as Uint8Array), toHex(first), "new messages produce a new snapshot")

  assert.equal(
    await persistPromptContextUsageSnapshot({
      blobStore, ctx, privacyMode: PrivacyMode.NO_STORAGE, rootPromptMessagesJson: messages, usageTree: tree,
    }),
    undefined,
    "a privacy mode that forbids storage writes nothing",
  )
  assert.equal(
    await persistPromptContextUsageSnapshot({
      blobStore, ctx, privacyMode: PrivacyMode.USAGE_DATA_TRAINING_ALLOWED, rootPromptMessagesJson: messages, usageTree: undefined,
    }),
    undefined,
  )
})

test("the project conversation is decided by its newest boundary", async () => {
  assert.equal(isRootProjectUserMessage({ projectDetails: {} }), true)
  assert.equal(isRootProjectUserMessage({ projectDetails: {}, bestOfNGroupId: "g" }), false)
  assert.equal(isRootProjectUserMessage({}), false)

  assert.equal(
    shouldOmitCloudWorkerProcedure({
      gateEnabled: true, agentType: AgentType.BACKGROUND, mode: AgentMode.AGENT,
      useLocalAgentPrompting: false, isNamedAgentSession: false, isRootProject: true,
    }),
    true,
  )
  assert.equal(
    shouldOmitCloudWorkerProcedure({
      gateEnabled: true, agentType: AgentType.IDE, mode: AgentMode.AGENT,
      useLocalAgentPrompting: false, isNamedAgentSession: false, isRootProject: true,
    }),
    false,
  )

  const turnOf = (userMessage: unknown) =>
    ({ get: async () => ({ userMessage: { get: async () => userMessage } }) }) as never
  const resolved = await resolveProjectConversationContext(createContext(), {
    turns: [
      turnOf({ mode: AgentMode.AGENT, projectDetails: {}, isSimulatedMsg: false }),
      turnOf({ mode: AgentMode.PLAN, isSimulatedMsg: true }),
    ],
  })
  assert.equal(resolved.hasProjectBoundary, true)
  assert.equal(resolved.isRootProject, true)
  assert.equal(resolved.lastMode, AgentMode.PLAN, "the newest mode seen is reported")

  const none = await resolveProjectConversationContext(createContext(), {
    turns: [turnOf({ mode: AgentMode.AGENT, isSimulatedMsg: true })],
  })
  assert.deepEqual(none, { lastMode: AgentMode.AGENT, isRootProject: false, hasProjectBoundary: false })
})

test("a rule is file-scoped when it is attached to files or nested below the workspace root", () => {
  const workspace = "/repo"
  assert.equal(isFileScopedRule({ type: { type: { case: "fileGlobbed" } } }, [workspace]), true)
  assert.equal(isFileScopedRule({ type: { type: { case: "global" } }, fullPath: "/repo/.slate/rules/a.mdc" }, [workspace]), false)
  assert.equal(
    isFileScopedRule({ type: { type: { case: "global" } }, fullPath: "/repo/pkg/.slate/rules/a.mdc" }, [workspace]),
    true,
    "a global rule below the root belongs to its subtree",
  )
  assert.equal(isFileScopedRule({ type: { type: { case: "other" } }, fullPath: "/repo/.slate/rules/a.mdc" }, [workspace]), false)
  assert.equal(isFileScopedRule({}, [workspace]), false)
})
