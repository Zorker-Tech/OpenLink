/**
 * The first user message: everything the agent is told about the session it is in.
 *
 * This is the composer. It gathers the sections — the machine and workspace, the git state, the rules,
 * the skills, the MCP catalogue, the cloud task instructions, the user's own profile and hooks — and
 * renders them into the message the model reads first. Which sections appear depends on what the
 * session is: a cloud run gets branch instructions and testing sections, a desktop subagent gets only
 * its own skills, a project conversation gets neither the cloud sections nor the workspace mutation
 * tools, and a session with a trimmed display option gets the machine facts and git status and nothing
 * else.
 *
 * Two orderings matter. The rules and skills come before the MCP catalogue, because the catalogue tells
 * the model how to reach tools the rules may already refer to. And the context block comes first, since
 * every later section is read in the light of where the session is.
 *
 * A model trained on a particular prompt version is given the MCP instructions in the system prompt
 * instead of here, and a model that never saw MCP at all is given none.
 */

import { AgentMode } from "../../proto/generated/agent/v1/agent_pb.ts"
import type { BackgroundComposerSource } from "../../proto/generated/aiserver/v1/background_composer_pb.ts"
import type { AgentSkill } from "../../proto/generated/agent/v1/agent_skills_pb.ts"
import type { CursorRule } from "../../proto/generated/agent/v1/rules_pb.ts"
import type { GitRepoInfo, RequestContextEnv } from "../../proto/generated/agent/v1/request_context_exec_pb.ts"
import type { McpDescriptor, McpFileSystemOptions, McpInstructions } from "../../proto/generated/agent/v1/mcp_pb.ts"
import { jsx, jsxs, Fragment, type PromptNode, type PromptProps } from "../../prompt-jsx/index.ts"
import { renderContent } from "../../prompt-jsx/index.ts"
import { AgentType } from "../utils/agent-config.ts"
import { materializeAutomationMemoryInstruction } from "./bug_report/automations.ts"
import { isNamedAgentHomePromptSession } from "./cloud-meta-agent/named-agent-sessions.ts"
import { getCloudTestingSectionElements, getCloudTestingSectionsPlacement } from "./cloud-testing-sections.ts"
import { CloudInstructionsSection, CloudTaskInstructions } from "./cloud-task-instructions.ts"
import {
  AutomationInstructionsSection,
  AvailableSubagentModelsSection,
  AvailableSubagentTypesSection,
  HooksAdditionalContextSection,
  MetaAgentProjectNotesDirectorySection,
  UserIntentSection,
} from "./user-info-sections.ts"
import { AgentTranscriptsSection } from "./agent-transcripts-section.ts"
import { GitStatusSection } from "./git-status-section.ts"
import { buildAvailableSkillsPromptSection } from "./available-skills-section.ts"
import { McpInstructionsSection } from "./mcp-instructions-section.ts"
import { McpMetaToolInstructions } from "./mcp-meta-tool-instructions.ts"
import { McpMetaToolServersSection, filterProjectWorkspaceMutationMcpDescriptors } from "./mcp-catalog.ts"
import { resolveAgentNotesDirectory } from "./agent-notes-directory.ts"
import { UserInfoSection } from "./user-info-section.ts"
import { getFriendlyDateForTimeZone } from "./friendly-date.ts"
import { buildRulesSection } from "./custom-user-rules.ts"
import { categorizeCursorRules } from "./rule-categorization.ts"
import { getMcpFileSystemInstructions } from "../utils/mcp-file-system.ts"

interface UserInfoToolInfo {
  readonly allTools?: Record<string, { readonly name?: string | undefined } | undefined>
  readonly availableSubagentTypesDescription?: string | undefined
  readonly availableSubagentModelsDescription?: string | undefined
  readonly [key: string]: unknown
}

interface UserInfoModelInfo {
  readonly modelName?: string | undefined
  /** A catalogue value: the prompt version a model was trained against. */
  readonly promptVersion?: string | undefined
  readonly isComposerMatterhorn?: boolean | undefined
  readonly isRawTrainingSlug?: boolean | undefined
  readonly isSlateProductPrompt?: boolean | undefined
  readonly isComposer2?: boolean | undefined
  readonly isComposer15?: boolean | undefined
  readonly isGpt56?: boolean | undefined
  readonly [key: string]: unknown
}

interface UserInfoDisplayOptions {
  readonly includeOnlyUserInfoAndGitStatus?: boolean | undefined
  readonly displayTodaysDate?: boolean | undefined
  readonly displayGitRepoStatusLine?: boolean | undefined
  readonly displayGitStatus?: boolean | undefined
  readonly excludeAgentTranscripts?: boolean | undefined
  readonly displayCursorRules?: boolean | undefined
  readonly displaySkills?: boolean | undefined
  readonly computerUseSubagentSurface?: boolean | undefined
  readonly agentType?: AgentType | undefined
}

interface UserInfoFeatureFlags {
  readonly dropCustomPromptContext?: boolean | undefined
  readonly shiftDsv3McpFilesInstructionsToUserMsg?: boolean | undefined
  readonly backgroundComposerMultiPrs?: boolean | undefined
  readonly cloudAgentStaleBuildGitRefs?: string | undefined
  readonly enableAgentChatLinks?: boolean | undefined
  readonly protectLoopSkillDescription?: boolean | undefined
  readonly prCreationForgeGuidance?: boolean | undefined
  readonly enableAntiAskQuestionUserRule?: boolean | undefined
  readonly enableMCPFileSystem?: boolean | undefined
  readonly enableTahomaUserRuleIntervention?: boolean | undefined
  readonly enableVegaFrontendUserRuleIntervention?: boolean | undefined
  readonly enableComposer2CustomUserRules?: boolean | undefined
  readonly enableMatterhornPromptTweaks?: boolean | undefined
  readonly enableGrepBroadGlobGuard?: boolean | undefined
  readonly slateCloudTestingInSystemPrompt?: boolean | undefined
  readonly [key: string]: unknown
}

interface UserInfoMcpMetaToolOptions {
  readonly enabled: boolean
  readonly mcpDescriptors: readonly McpDescriptor[]
  readonly snapshotToolNames?: {
    readonly discoveryToolName?: string | undefined
    readonly invocationToolName?: string | undefined
    readonly useDynamicToolNamespaces?: boolean | undefined
    readonly fetchMcpResourceToolName?: string | undefined
    readonly listMcpResourcesToolName?: string | undefined
  } | undefined
}

export interface UserInfoProps {
  readonly cursorRules: CursorRule[]
  readonly agentSkills?: AgentSkill[] | undefined
  readonly env?: RequestContextEnv | undefined
  readonly isLargeContextModel?: boolean | undefined
  readonly mode?: AgentMode | undefined
  readonly gitRepos?: GitRepoInfo[] | undefined
  readonly gitRepoInfoComplete?: boolean | undefined
  readonly terminalsFolder?: string | undefined
  readonly agentSharedNotesFolder?: string | undefined
  readonly agentConversationNotesFolder?: string | undefined
  readonly metaAgentNotesEnabled?: boolean | undefined
  readonly notesSessionId?: string | undefined
  readonly featureFlags?: UserInfoFeatureFlags | undefined
  readonly modelInfo?: UserInfoModelInfo | undefined
  readonly displayOptions?: UserInfoDisplayOptions | undefined
  readonly toolInfo?: UserInfoToolInfo | undefined
  readonly backgroundAgentSource?: BackgroundComposerSource | undefined
  readonly agentType?: AgentType | undefined
  readonly cloudRule?: string | undefined
  readonly mcpInstructions?: readonly McpInstructions[] | undefined
  readonly mcpMetaToolOptions?: UserInfoMcpMetaToolOptions | undefined
  readonly mcpFileSystemOptions?: McpFileSystemOptions | undefined
  readonly mcpInfoComplete?: boolean | undefined
  readonly enableFilterEditToolsInAskMode?: boolean | undefined
  readonly isRootProject?: boolean | undefined
  readonly userIntentSummary?: string | undefined
  readonly hooksAdditionalContext?: string | undefined
  readonly automationInstructions?: string | undefined
  readonly namedAgentSelfDocumentBlock?: string | undefined
  readonly agentTranscriptsFolder?: string | undefined
  readonly enableComposer2IntelligentTestingPromptSection?: boolean | undefined
  readonly agentTokenLimit?: number | undefined
  readonly isThreadSurface?: boolean | undefined
  readonly enableCloudTesting?: boolean | undefined
  readonly priorUserInfoCloudTestingSectionsPlacement?: string | undefined
  readonly namedAgentSessionKind?: string | undefined
  readonly isCloudMetaAgentParent?: boolean | undefined
  readonly subagentType?: { readonly type?: { readonly case?: string | undefined } | undefined } | undefined
  readonly useLocalAgentPrompting?: boolean | undefined
  readonly omitCloudWorkerProcedure?: boolean | undefined
  readonly designatedBranches?: readonly {
    readonly path?: string | undefined
    readonly repoPath?: string | undefined
    readonly branchName?: string | undefined
    readonly baseBranch?: string | undefined
    readonly remoteUrl?: string | undefined
  }[] | undefined
  readonly branchPrefix?: string | undefined
  readonly branchSuffix?: string | undefined
  readonly preferCurrentBranchInMultiPrMode?: boolean | undefined
  readonly browserTools?: readonly string[] | undefined
  readonly isRepoless?: boolean | undefined
  readonly skipMcpInstructions?: boolean | undefined
}

const UserInfoSectionPrompt = UserInfoSection as unknown as (props: PromptProps) => PromptNode
const GitStatusSectionPrompt = GitStatusSection as unknown as (props: PromptProps) => PromptNode
const CloudTaskInstructionsPrompt = CloudTaskInstructions as unknown as (props: PromptProps) => PromptNode
const McpMetaToolServersSectionPrompt = McpMetaToolServersSection as unknown as (props: PromptProps) => PromptNode
const AvailableSubagentTypesSectionPrompt = AvailableSubagentTypesSection as unknown as (props: PromptProps) => PromptNode
const AvailableSubagentModelsSectionPrompt = AvailableSubagentModelsSection as unknown as (props: PromptProps) => PromptNode

function UserInfoComponent({ props }: { readonly props: UserInfoProps }): PromptNode {
  const dropCustomPromptContext = props.featureFlags?.dropCustomPromptContext === true
  const gitRepos = props.gitRepos ?? []
  const hasGitRepos = gitRepos.length > 0
  const gitRepoInfoComplete = props.gitRepoInfoComplete
  const workspacePaths = props.env?.workspacePaths ?? []
  const { globalRules, agentRequestableRules, userRules, skills } = categorizeCursorRules(
    props.cursorRules,
    workspacePaths,
    props.displayOptions?.agentType,
  )
  const readToolName = props.toolInfo?.allTools?.READ?.name
  const awaitToolName = props.toolInfo?.allTools?.AWAIT?.name
  const shellToolName = props.toolInfo?.allTools?.SHELL?.name
  const grepToolName = props.toolInfo?.allTools?.GREP?.name
  const { section: rulesSection } = buildRulesSection(props as Parameters<typeof buildRulesSection>[0], {
    categorizedRules: { globalRules, agentRequestableRules, userRules },
    readToolName,
    awaitToolName,
    shellToolName,
    grepToolName,
  })
  const { section: availableSkillsSection } = buildAvailableSkillsPromptSection(props, { skills, readToolName })
  const todaysDate = getFriendlyDateForTimeZone(props.env?.timeZone)
  const cloudRuleContent = props.cloudRule?.trim() ?? ""
  // A model trained without MCP is given none of it, however the session is configured.
  const disableMcpForRawMatterhorn = props.modelInfo?.isComposerMatterhorn === true && props.modelInfo.isRawTrainingSlug === true
  const mcpEntries = disableMcpForRawMatterhorn
    ? []
    : (props.mcpInstructions ?? []).filter(entry => typeof entry?.instructions === "string" && entry.instructions.trim().length > 0)
  const shouldFilterEditToolsInAskMode = props.mode === AgentMode.ASK && (props.enableFilterEditToolsInAskMode ?? true)
  const shouldRestrictProjectWorkspace = props.mode === AgentMode.PROJECT || props.isRootProject === true
  // A project conversation may not move the agent out of its own root.
  const mcpMetaToolOptions = shouldRestrictProjectWorkspace && props.mcpMetaToolOptions !== undefined
    ? { ...props.mcpMetaToolOptions, mcpDescriptors: filterProjectWorkspaceMutationMcpDescriptors(props.mcpMetaToolOptions.mcpDescriptors) }
    : props.mcpMetaToolOptions
  const shouldShowMcpMetaToolSnapshot = mcpMetaToolOptions?.enabled === true &&
    mcpMetaToolOptions.mcpDescriptors.length > 0 &&
    !disableMcpForRawMatterhorn &&
    !shouldFilterEditToolsInAskMode
  const largeContextMcpMetaInstructions = props.isLargeContextModel === true &&
      shouldShowMcpMetaToolSnapshot &&
      mcpMetaToolOptions !== undefined
    ? McpMetaToolInstructions(mcpMetaToolOptions.mcpDescriptors, {
      discoveryToolName: mcpMetaToolOptions.snapshotToolNames?.discoveryToolName ?? "GetMcpTools",
      invocationToolName: mcpMetaToolOptions.snapshotToolNames?.invocationToolName ?? "CallMcpTool",
      useDynamicToolNamespaces: mcpMetaToolOptions.snapshotToolNames?.useDynamicToolNamespaces ?? false,
      ...(mcpMetaToolOptions.snapshotToolNames?.fetchMcpResourceToolName
        ? { fetchMcpResourceToolName: mcpMetaToolOptions.snapshotToolNames.fetchMcpResourceToolName }
        : mcpMetaToolOptions.snapshotToolNames?.useDynamicToolNamespaces
          ? {}
          : { fetchMcpResourceToolName: "FetchMcpResource" }),
      ...(mcpMetaToolOptions.snapshotToolNames?.listMcpResourcesToolName
        ? { listMcpResourcesToolName: mcpMetaToolOptions.snapshotToolNames.listMcpResourcesToolName }
        : {}),
    })
    : ""
  const shouldShiftMcpFilesInstructionsToUserMsg = props.featureFlags?.shiftDsv3McpFilesInstructionsToUserMsg === true
  const mcpInstructionsForUserMsg = props.isLargeContextModel === true &&
      shouldShiftMcpFilesInstructionsToUserMsg &&
      !disableMcpForRawMatterhorn
    ? getMcpFileSystemInstructions({
      mode: props.mode,
      enableFilterEditToolsInAskMode: props.enableFilterEditToolsInAskMode,
      mcpFileSystemOptions: props.mcpFileSystemOptions,
      mcpMetaToolOptions: mcpMetaToolOptions
        ? { enabled: mcpMetaToolOptions.enabled, mcpDescriptors: mcpMetaToolOptions.mcpDescriptors } as never
        : undefined,
      featureFlags: props.featureFlags,
      modelInfo: props.modelInfo,
    })
    : ""
  const mcpInstructionsBlock = mcpInstructionsForUserMsg.length > 0 ? `\n\n${mcpInstructionsForUserMsg}` : ""
  const gitReposWithStatus = gitRepos.filter(repo => !!repo.status)
  const userIntentContent = props.userIntentSummary?.trim() ?? ""
  const includeOnlyUserInfoAndGitStatus = props.displayOptions?.includeOnlyUserInfoAndGitStatus === true
  const displayTodaysDate = props.displayOptions?.displayTodaysDate !== false
  const displayGitRepoStatusLine = props.displayOptions?.displayGitRepoStatusLine !== false
  const useLocalAgentPrompting = props.useLocalAgentPrompting === true
  const isNamedAgentHome = isNamedAgentHomePromptSession(props)
  const resolvedAgentType = useLocalAgentPrompting ? AgentType.IDE : props.agentType ?? props.displayOptions?.agentType
  const initialWorkingDirectory = props.env?.processWorkingDirectory?.trim() || undefined
  const shouldRenderCloudTaskInstructions = props.designatedBranches !== undefined &&
    props.omitCloudWorkerProcedure !== true &&
    !useLocalAgentPrompting &&
    !isNamedAgentHome &&
    props.displayOptions?.computerUseSubagentSurface !== true
  const metaAgentNotesDirectory = resolveAgentNotesDirectory(props)
  if (includeOnlyUserInfoAndGitStatus) {
    return jsxs(Fragment, {
      children: [
        props.toolInfo?.availableSubagentTypesDescription !== undefined &&
          jsx(AvailableSubagentTypesSectionPrompt, { description: props.toolInfo.availableSubagentTypesDescription }),
        props.toolInfo?.availableSubagentModelsDescription !== undefined &&
          jsx(AvailableSubagentModelsSectionPrompt, { description: props.toolInfo.availableSubagentModelsDescription }),
        props.env !== undefined && jsx(UserInfoSectionPrompt, {
          env: props.env,
          isLargeContextModel: props.isLargeContextModel,
          mode: props.mode,
          hasGitRepos,
          gitRepoInfoComplete,
          gitRepos,
          todaysDate,
          terminalsFolder: props.terminalsFolder,
          agentSharedNotesFolder: props.agentSharedNotesFolder,
          agentConversationNotesFolder: props.agentConversationNotesFolder,
          metaAgentNotesDirectory,
          metaAgentNotesEnabled: props.metaAgentNotesEnabled,
          displayTodaysDate,
          displayGitRepoStatusLine,
        }),
        metaAgentNotesDirectory !== undefined &&
          jsx(MetaAgentProjectNotesDirectorySection as unknown as (props: PromptProps) => PromptNode, { notesDirectory: metaAgentNotesDirectory }),
        props.displayOptions?.displayGitStatus !== false && gitReposWithStatus.length > 0 &&
          jsx(GitStatusSectionPrompt, { gitRepos, gitReposWithStatus, initialWorkingDirectory, agentType: resolvedAgentType, toolInfo: props.toolInfo }),
      ],
    })
  }
  const computerUseSubagentSurface = props.displayOptions?.computerUseSubagentSurface === true
  const cloudTestingSections = !computerUseSubagentSurface &&
      props.omitCloudWorkerProcedure !== true &&
      getCloudTestingSectionsPlacement(props as never) === "user_info"
    ? getCloudTestingSectionElements(props as never)
    : undefined
  const automationInstructions = props.automationInstructions === undefined
    ? undefined
    : materializeAutomationMemoryInstruction(props.automationInstructions, props.env?.mountedAgentStores ?? [])
  return jsxs(Fragment, {
    children: [
      props.env !== undefined && jsx(UserInfoSectionPrompt, {
        env: props.env,
        isLargeContextModel: props.isLargeContextModel,
        mode: props.mode,
        hasGitRepos,
        gitRepoInfoComplete,
        gitRepos,
        todaysDate,
        terminalsFolder: props.terminalsFolder,
        agentSharedNotesFolder: props.agentSharedNotesFolder,
        agentConversationNotesFolder: props.agentConversationNotesFolder,
        metaAgentNotesDirectory,
        metaAgentNotesEnabled: props.metaAgentNotesEnabled,
        displayTodaysDate,
        displayGitRepoStatusLine,
      }),
      props.namedAgentSelfDocumentBlock !== undefined && jsx("p", { children: props.namedAgentSelfDocumentBlock }),
      metaAgentNotesDirectory !== undefined &&
        jsx(MetaAgentProjectNotesDirectorySection as unknown as (props: PromptProps) => PromptNode, { notesDirectory: metaAgentNotesDirectory }),
      userIntentContent.length > 0 &&
        jsx(UserIntentSection as unknown as (props: PromptProps) => PromptNode, { content: userIntentContent }),
      props.displayOptions?.displayGitStatus !== false && gitReposWithStatus.length > 0 &&
        jsx(GitStatusSectionPrompt, { gitRepos, gitReposWithStatus, initialWorkingDirectory, agentType: resolvedAgentType, toolInfo: props.toolInfo }),
      cloudTestingSections?.gitAndSubmission,
      !props.displayOptions?.excludeAgentTranscripts &&
        props.env?.agentTranscriptsFolder &&
        props.displayOptions?.agentType !== AgentType.BACKGROUND &&
        jsx(AgentTranscriptsSection as unknown as (props: PromptProps) => PromptNode, {
          agentTranscriptsFolder: props.env.agentTranscriptsFolder,
          agentType: props.displayOptions?.agentType,
          enableAgentChatLinks: props.featureFlags?.enableAgentChatLinks !== false,
        }),
      !computerUseSubagentSurface && !dropCustomPromptContext && rulesSection,
      !computerUseSubagentSurface && props.toolInfo?.availableSubagentTypesDescription !== undefined &&
        jsx(AvailableSubagentTypesSectionPrompt, { description: props.toolInfo.availableSubagentTypesDescription }),
      !computerUseSubagentSurface && props.toolInfo?.availableSubagentModelsDescription !== undefined &&
        jsx(AvailableSubagentModelsSectionPrompt, { description: props.toolInfo.availableSubagentModelsDescription }),
      !computerUseSubagentSurface && !dropCustomPromptContext && availableSkillsSection,
      !computerUseSubagentSurface && cloudRuleContent.length > 0 &&
        jsx(CloudInstructionsSection as unknown as (props: PromptProps) => PromptNode, { cloudRuleContent }),
      cloudTestingSections?.testing,
      cloudTestingSections?.computerUse,
      shouldRenderCloudTaskInstructions && jsx(CloudTaskInstructionsPrompt, {
        gitRepos,
        designatedBranches: props.designatedBranches,
        branchPrefix: props.branchPrefix,
        branchSuffix: props.branchSuffix,
        preferCurrentBranchInMultiPrMode: props.preferCurrentBranchInMultiPrMode,
        allowMultipleBranches: props.featureFlags?.backgroundComposerMultiPrs ?? false,
        toolInfo: props.toolInfo,
        staleBuildGitRefs: props.featureFlags?.cloudAgentStaleBuildGitRefs,
      }),
      !computerUseSubagentSurface && !dropCustomPromptContext && mcpInstructionsBlock,
      !computerUseSubagentSurface && !dropCustomPromptContext && largeContextMcpMetaInstructions.length > 0 && largeContextMcpMetaInstructions,
      !computerUseSubagentSurface && !dropCustomPromptContext && shouldShowMcpMetaToolSnapshot && props.isLargeContextModel !== true && mcpMetaToolOptions !== undefined &&
        jsx(McpMetaToolServersSectionPrompt, { mcpMetaToolOptions, mcpInfoComplete: props.mcpInfoComplete }),
      !computerUseSubagentSurface && !dropCustomPromptContext && !props.skipMcpInstructions && mcpEntries.length > 0 &&
        jsx(McpInstructionsSection as unknown as (props: PromptProps) => PromptNode, { mcpEntries }),
      props.hooksAdditionalContext && props.hooksAdditionalContext.trim().length > 0 &&
        jsx(HooksAdditionalContextSection as unknown as (props: PromptProps) => PromptNode, { content: props.hooksAdditionalContext }),
      automationInstructions !== undefined && automationInstructions.trim().length > 0 &&
        jsx(AutomationInstructionsSection as unknown as (props: PromptProps) => PromptNode, { content: automationInstructions }),
    ],
  })
}

export function UserInfo(props: UserInfoProps): string {
  return renderContent(jsx(UserInfoComponent as unknown as (props: PromptProps) => PromptNode, { props }))
}
