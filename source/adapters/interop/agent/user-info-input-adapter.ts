import { AgentMode } from "../proto/generated/agent/v1/agent_pb.ts"
import { CursorRuleSource, type CursorRule } from "../proto/generated/agent/v1/rules_pb.ts"
import { filterInteropProjectWorkspaceMutationMcpDescriptors } from "./project-workspace-mcp-adapter.ts"
import type { AgentSkill } from "../proto/generated/agent/v1/agent_skills_pb.ts"
import {
  MountedAgentStoreKind,
  type GitRepoInfo,
  type MountedAgentStore,
  type RequestContextEnv,
} from "../proto/generated/agent/v1/request_context_exec_pb.ts"
import type {
  McpDescriptor,
  McpFileSystemOptions,
  McpInstructions,
} from "../proto/generated/agent/v1/mcp_pb.ts"
import type { BackgroundComposerSource } from "../proto/generated/aiserver/v1/background_composer_pb.ts"
import { getCloudTestingSectionElements, getCloudTestingSectionsPlacement } from "../../../packages/agent/prompts/cloud-testing-sections.ts"
import { projectBackgroundAgentSource } from "./background-agent-source-adapter.ts"
import { UserInfo, type UserInfoProps } from "../../../packages/agent/prompts/user-info.ts"
import { AgentType } from "../../../packages/agent/utils/agent-config.ts"
import { buildAntiAskQuestionUserRule } from "../../../packages/agent/prompts/ask-question-guidance.ts"
import { shouldInjectGitWorkflowRules } from "../../../packages/agent/prompts/git-workflow-rule-policy.ts"
import { getGitWorkflowUserRules } from "../../../packages/agent/prompts/git-workflow-rules.ts"
import { adaptGitWorkflowModelCapability } from "./git-workflow-model-capability-adapter.ts"
import { getGeneratedUserRulesForModel } from "./user-rule-profile-adapter.ts"
import { adaptInteropCloudTestingModelProfile } from "./testing-prompt-profile-adapter.ts"
import type { UserInfoMode } from "../../../packages/agent/prompts/user-info-profile-contract.ts"
import type {
  UserInfoEnvironment,
  UserInfoGitRepository,
  UserInfoMcpDescriptor,
  UserInfoMcpFileSystemOptions,
  UserInfoMcpInstructions,
  UserInfoMcpMetaToolOptions,
  UserInfoMountedStore,
  UserInfoRule,
  UserInfoSkill,
} from "../../../packages/agent/prompts/user-info-data-contracts.ts"

interface UserInfoInteropModelInfo {
  readonly modelName?: string | undefined
  readonly promptVersion?: string | undefined
  readonly isComposerMatterhorn?: boolean | undefined
  readonly isRawTrainingSlug?: boolean | undefined
  readonly isSlateProductPrompt?: boolean | undefined
  readonly isComposer2?: boolean | undefined
  readonly isComposer15?: boolean | undefined
  readonly isGpt56?: boolean | undefined
  readonly [key: string]: unknown
}

type CoreInput = Omit<
  UserInfoProps,
  | "workspaceRules"
  | "agentSkills"
  | "env"
  | "gitRepos"
  | "mode"
  | "modelProfile"
  | "additionalUserRules"
  | "cloudTestingSections"
  | "mcpInstructions"
  | "mcpMetaToolOptions"
  | "mcpFileSystemOptions"
>

/** Values still arriving from the action/request-context wire boundary. */
export type InteropUserInfoInput = CoreInput & {
  readonly rules?: readonly CursorRule[] | undefined
  readonly agentSkills?: readonly AgentSkill[] | undefined
  readonly env?: RequestContextEnv | undefined
  readonly gitRepos?: readonly GitRepoInfo[] | undefined
  readonly mcpInstructions?: readonly McpInstructions[] | undefined
  readonly mcpMetaToolOptions?: Omit<UserInfoMcpMetaToolOptions, "mcpDescriptors"> & {
    readonly mcpDescriptors: readonly McpDescriptor[]
  } | undefined
  readonly mcpFileSystemOptions?: Omit<UserInfoMcpFileSystemOptions, "mcpDescriptors"> & {
    readonly mcpDescriptors: readonly McpDescriptor[]
  } | undefined
  readonly mode?: AgentMode | undefined
  readonly modelInfo?: UserInfoInteropModelInfo | undefined
  readonly backgroundAgentSource?: BackgroundComposerSource | undefined
  readonly enableComposer2IntelligentTestingPromptSection?: boolean | undefined
  readonly enableCloudTesting?: boolean | undefined
  readonly priorUserInfoCloudTestingSectionsPlacement?: string | undefined
  readonly subagentType?: { readonly type?: { readonly case?: string | undefined } | undefined } | undefined
  readonly browserTools?: readonly string[] | undefined
}

function projectRuleType(rule: CursorRule): UserInfoRule["type"] {
  const selected = rule.type?.type
  if (selected === undefined || selected.case === undefined) return undefined
  switch (selected.case) {
    case "fileGlobbed":
      return { type: { case: selected.case, value: { globs: [...selected.value.globs] } } }
    case "agentFetched":
      return { type: { case: selected.case, value: { description: selected.value.description } } }
    case "global":
    case "manuallyAttached":
      return { type: { case: selected.case, value: {} } }
  }
}

/** Projects only prompt-relevant rule facts; wire messages stay at the interop boundary. */
export function projectInteropCursorRule(rule: CursorRule): UserInfoRule {
  return {
    fullPath: rule.fullPath,
    content: rule.content,
    source: rule.source === CursorRuleSource.USER
      ? "user"
      : rule.source === CursorRuleSource.TEAM
        ? "team"
        : "unspecified",
    environments: [...(rule.environments ?? [])],
    disabledEnvironments: [...(rule.disabledEnvironments ?? [])],
    type: projectRuleType(rule),
  }
}

export function projectInteropRules(rules: readonly unknown[]): UserInfoRule[] {
  return rules.map(rule => projectInteropCursorRule(rule as CursorRule))
}

function projectInteropAgentSkill(skill: AgentSkill): UserInfoSkill {
  return {
    fullPath: skill.fullPath,
    content: skill.content,
    description: skill.description,
    globs: [...(skill.globs ?? [])],
    environments: [...(skill.environments ?? [])],
    disabledEnvironments: [...(skill.disabledEnvironments ?? [])],
    disableModelInvocation: skill.disableModelInvocation ?? false,
  }
}

export function projectInteropAgentSkills(skills: readonly unknown[] | undefined): UserInfoSkill[] | undefined {
  return skills?.map(skill => projectInteropAgentSkill(skill as AgentSkill))
}

function projectMountedStore(store: MountedAgentStore): UserInfoMountedStore {
  const kind = store.kind === MountedAgentStoreKind.SELF
    ? "self"
    : store.kind === MountedAgentStoreKind.PEER
      ? "peer"
      : store.kind === MountedAgentStoreKind.SHARE
        ? "share"
        : store.kind === MountedAgentStoreKind.PRINCIPAL
          ? "principal"
          : "unspecified"
  return {
    path: store.path,
    kind,
    ...(store.alias === undefined ? {} : { alias: store.alias }),
    readOnly: store.readOnly,
  }
}

export function projectInteropEnvironment(value: unknown): UserInfoEnvironment | undefined {
  if (value === undefined) return undefined
  const env = value as RequestContextEnv
  return {
    osVersion: env.osVersion,
    shell: env.shell,
    workspacePaths: [...(env.workspacePaths ?? [])],
    projectFolder: env.projectFolder,
    timeZone: env.timeZone,
    processWorkingDirectory: env.processWorkingDirectory,
    agentTranscriptsFolder: env.agentTranscriptsFolder,
    isWorkingDirHomeDir: env.isWorkingDirHomeDir,
    mountedAgentStores: (env.mountedAgentStores ?? []).map(projectMountedStore),
  }
}

export function projectInteropGitRepositories(repositories: readonly GitRepoInfo[] | undefined): UserInfoGitRepository[] | undefined {
  return repositories?.map(repository => ({
    path: repository.path,
    status: repository.status,
    ...(repository.remoteUrl === undefined ? {} : { remoteUrl: repository.remoteUrl }),
  }))
}

function projectMcpDescriptor(descriptor: McpDescriptor): UserInfoMcpDescriptor {
  return {
    serverName: descriptor.serverName,
    serverIdentifier: descriptor.serverIdentifier,
    folderPath: descriptor.folderPath,
    serverUseInstructions: descriptor.serverUseInstructions,
    tools: descriptor.tools.map(tool => ({ toolName: tool.toolName })),
  }
}

function projectMcpDescriptors(descriptors: readonly McpDescriptor[], removeWorkspaceMutationTools: boolean): UserInfoMcpDescriptor[] {
  const projectedDescriptors = removeWorkspaceMutationTools
    ? filterInteropProjectWorkspaceMutationMcpDescriptors(descriptors)
    : descriptors
  return projectedDescriptors.map(projectMcpDescriptor)
}

function projectMcpMetaToolOptions(
  options: InteropUserInfoInput["mcpMetaToolOptions"],
  removeWorkspaceMutationTools: boolean,
): UserInfoMcpMetaToolOptions | undefined {
  if (options === undefined) return undefined
  return {
    enabled: options.enabled,
    mcpDescriptors: projectMcpDescriptors(options.mcpDescriptors, removeWorkspaceMutationTools),
    snapshotToolNames: options.snapshotToolNames,
  }
}

function projectMcpFileSystemOptions(
  options: InteropUserInfoInput["mcpFileSystemOptions"],
): UserInfoMcpFileSystemOptions | undefined {
  if (options === undefined) return undefined
  return {
    enabled: options.enabled,
    workspaceProjectDir: options.workspaceProjectDir,
    mcpDescriptors: projectMcpDescriptors(options.mcpDescriptors, false),
  }
}

function projectMcpInstructions(entries: readonly McpInstructions[] | undefined): UserInfoMcpInstructions[] | undefined {
  return entries?.map(entry => ({ serverName: entry.serverName, instructions: entry.instructions }))
}

export function decodeUserInfoMode(mode: AgentMode | undefined): UserInfoMode | undefined {
  if (mode === undefined || mode === AgentMode.UNSPECIFIED || mode === AgentMode.AGENT) return "agent"
  if (mode === AgentMode.ASK) return "ask"
  if (mode === AgentMode.PROJECT) return "project"
  if (mode === AgentMode.MULTITASK) return "multitask"
  return { kind: "unrecognized", value: mode }
}

/** Model-family details are translated once, before the session prompt uses them. */
function modelProfile(modelInfo: UserInfoInteropModelInfo | undefined) {
  const usesPascalCaseTools = modelInfo?.isComposerMatterhorn === true && modelInfo.isRawTrainingSlug !== true
  return {
    suppressMcpContext: modelInfo?.isComposerMatterhorn === true && modelInfo.isRawTrainingSlug === true,
    gpt56SkillBudget: modelInfo?.isGpt56 === true,
    mcpToolNameStyle: usesPascalCaseTools ? "pascal" as const : "snake" as const,
  }
}

function additionalRules(input: InteropUserInfoInput): string[] {
  const awaitToolName = input.toolInfo?.allTools?.AWAIT?.name
  const shellToolName = input.toolInfo?.allTools?.SHELL?.name
  const grepToolName = input.toolInfo?.allTools?.GREP?.name
  const generated = getGeneratedUserRulesForModel(input.modelInfo, input.featureFlags, {
    awaitToolName,
    shellToolName,
    grepToolName,
  })
  const agentType = input.displayOptions?.agentType ?? input.agentType
  const gitGuidance = input.backgroundAgentSource === undefined &&
      shouldInjectGitWorkflowRules(adaptGitWorkflowModelCapability(input.modelInfo), agentType) &&
      input.toolInfo?.allTools !== undefined
    ? getGitWorkflowUserRules(input.toolInfo, input.featureFlags?.prCreationForgeGuidance === true)
    : []
  const askToolName = input.toolInfo?.allTools?.ASK_QUESTION?.name ?? "AskQuestion"
  const askGuidance = input.featureFlags?.enableAntiAskQuestionUserRule === true
    ? [buildAntiAskQuestionUserRule(askToolName)]
    : []
  return [...askGuidance, ...gitGuidance, ...generated]
}

function cloudTestingSections(input: InteropUserInfoInput) {
  if (
    input.displayOptions?.includeOnlyUserInfoAndGitStatus === true ||
    input.displayOptions?.computerUseSubagentSurface === true ||
    input.omitCloudWorkerProcedure === true
  ) {
    return undefined
  }
  const { rules: _rules, ...ownedInputs } = input
  const promptInput = {
    ...ownedInputs,
    modelInfo: adaptInteropCloudTestingModelProfile(input.modelInfo),
    backgroundAgentSource: projectBackgroundAgentSource(input.backgroundAgentSource),
  }
  const placement = getCloudTestingSectionsPlacement(promptInput as never)
  return placement === "user_info" ? getCloudTestingSectionElements(promptInput as never) : undefined
}

/** Adapts the action's model and mode metadata before the owned prompt renderer composes its sections. */
export function renderInteropUserInfo(input: InteropUserInfoInput): string {
  const {
    mode,
    modelInfo,
    rules: _rules,
    agentSkills: _agentSkills,
    env: _env,
    gitRepos: _gitRepos,
    mcpInstructions: _mcpInstructions,
    mcpMetaToolOptions: _mcpMetaToolOptions,
    mcpFileSystemOptions: _mcpFileSystemOptions,
    backgroundAgentSource: _backgroundAgentSource,
    enableComposer2IntelligentTestingPromptSection: _enableComposer2IntelligentTestingPromptSection,
    enableCloudTesting: _enableCloudTesting,
    priorUserInfoCloudTestingSectionsPlacement: _priorPlacement,
    subagentType: _subagentType,
    browserTools: _browserTools,
    ...ownedInputs
  } = input
  const decodedMode = decodeUserInfoMode(mode)
  const shouldRestrictProjectWorkspace = decodedMode === "project" || input.isRootProject === true
  return UserInfo({
    ...ownedInputs,
    workspaceRules: projectInteropRules(_rules ?? []),
    agentSkills: projectInteropAgentSkills(_agentSkills),
    env: projectInteropEnvironment(_env),
    gitRepos: projectInteropGitRepositories(_gitRepos),
    mcpInstructions: projectMcpInstructions(_mcpInstructions),
    mcpMetaToolOptions: projectMcpMetaToolOptions(_mcpMetaToolOptions, shouldRestrictProjectWorkspace),
    mcpFileSystemOptions: projectMcpFileSystemOptions(_mcpFileSystemOptions),
    mode: decodedMode,
    modelProfile: modelProfile(modelInfo),
    additionalUserRules: additionalRules(input),
    cloudTestingSections: cloudTestingSections(input),
  })
}

export { additionalRules as resolveAdditionalUserRules }
