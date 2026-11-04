/**
 * Where the cloud testing sections go, and what they contain.
 *
 * A cloud run tests differently from a local one — it has a browser, an artifacts folder that is
 * uploaded at the end, and no repository in some cases — so its testing instructions are their own. The
 * question this file answers is not just what they say but *where* they go: the system prompt or the
 * first user message. That placement is remembered across turns (a session that has been sent one way
 * keeps going that way), and a session that has never had them placed gets the default for its model.
 *
 * The sections are built together because they depend on each other: the testing instructions name the
 * desktop subagent, the desktop instructions name the shell tool, and both are told which browser tools
 * exist — so the context is resolved once and passed to all three.
 */

import { jsx, jsxs, type PromptNode } from "../../prompt-jsx/index.ts"
import { getBrowserMcpProviderName } from "../browser-tools.ts"
import {
  AgentType,
  type BackgroundAgentSource,
  isCloudAgentTestingPromptEligibleEnvironment,
  shouldEnableComputerUse,
  shouldUseExperimentalCloudBehavior,
} from "../utils/agent-config.ts"
import { isNamedAgentHomePromptSession } from "./cloud-meta-agent/named-agent-sessions.ts"
import { isThreadBoundSession } from "./thread-bound-session.ts"
import { projectThreadSessionKind } from "../../../adapters/interop/agent/thread-session-kind-adapter.ts"
import { ComputerUseInstructionsSection, GitOrNoRepositoryInstructions } from "./prompt-sections.ts"
import { TestingInstructions2 } from "./testing/instructions.ts"

type ComposerToolInfo = {
  readonly allTools: Record<string, { readonly name: string } | undefined>
  readonly [key: string]: unknown
}

type ComposerEnvironment = {
  readonly artifactsFolder?: string | undefined
  readonly [key: string]: unknown
}

interface CloudTestingSectionsProps {
  readonly modelInfo?: {
    readonly modelName?: string | undefined
    readonly usesShellLessCloudPrompt?: boolean | undefined
    readonly isSlateProductPrompt?: boolean | undefined
    readonly [key: string]: unknown
  } | undefined
  readonly enableComposer2IntelligentTestingPromptSection?: boolean | undefined
  readonly backgroundAgentSource?: BackgroundAgentSource | undefined
  readonly agentType?: AgentType | undefined
  readonly enableCloudTesting?: boolean | undefined
  readonly priorUserInfoCloudTestingSectionsPlacement?: string | undefined
  readonly featureFlags?: {
    readonly slateCloudTestingInSystemPrompt?: boolean | undefined
  } | undefined
  readonly namedAgentSessionKind?: string | undefined
  readonly isCloudMetaAgentParent?: boolean | undefined
  readonly subagentType?: { readonly type?: { readonly case?: string | undefined } | undefined } | undefined
  readonly useLocalAgentPrompting?: boolean | undefined
  readonly env?: ComposerEnvironment | undefined
  readonly browserTools?: readonly string[] | undefined
  readonly cloudRule?: unknown
  readonly mode?: unknown
  readonly toolInfo?: ComposerToolInfo | undefined
  readonly isDev?: boolean | undefined
  readonly isRepoless?: boolean | undefined
  readonly isThreadSurface?: boolean | undefined
}

interface CloudTestingSectionElementsOptions {
  readonly omitTestingWorkflow?: boolean | undefined
}

export function parseCloudTestingSectionsPlacementMetadata(value: unknown): "user_info" | "system_prompt" | undefined {
  return value === "user_info" || value === "system_prompt" ? value : undefined
}

export function getCloudTestingSectionsPlacement(
  props: CloudTestingSectionsProps,
): "user_info" | "system_prompt" | undefined {
  const eligible = !isNamedAgentHomePromptSession(props) &&
    props.modelInfo?.usesShellLessCloudPrompt === true &&
    props.enableComposer2IntelligentTestingPromptSection === true &&
    props.backgroundAgentSource !== undefined &&
    props.agentType !== undefined &&
    shouldUseExperimentalCloudBehavior({
      agentType: props.agentType,
      enableCloudTesting: props.enableCloudTesting ?? false,
    }) &&
    isCloudAgentTestingPromptEligibleEnvironment(props.backgroundAgentSource)
  if (!eligible) return undefined
  const prior = props.priorUserInfoCloudTestingSectionsPlacement
  const isSlateProductPrompt = props.modelInfo?.isSlateProductPrompt === true
  // A placement already used is kept, except that one model family may move back into the system prompt.
  if (prior === "system_prompt") return isSlateProductPrompt ? "system_prompt" : "user_info"
  if (prior === "user_info") return "user_info"
  return isSlateProductPrompt && props.featureFlags?.slateCloudTestingInSystemPrompt === true
    ? "system_prompt"
    : "user_info"
}

function getCloudSectionContext(props: CloudTestingSectionsProps) {
  if (
    props.useLocalAgentPrompting === true ||
    props.backgroundAgentSource === undefined ||
    props.agentType === undefined ||
    props.modelInfo === undefined ||
    props.toolInfo === undefined
  ) {
    return undefined
  }
  const enableCloudTesting = props.enableCloudTesting ?? false
  const enableComputerUse = shouldEnableComputerUse({
    agentType: props.agentType,
    enableCloudTesting,
    backgroundAgentSource: props.backgroundAgentSource,
    modelId: props.modelInfo.modelName as string,
    isBackground: props.agentType === AgentType.BACKGROUND,
  }) ?? false
  const testingPromptProps = {
    env: props.env,
    browserTools: props.browserTools,
    cloudRule: props.cloudRule,
    mode: props.mode,
    agentType: props.agentType,
    isDev: false,
    enableCloudTesting,
    backgroundAgentSource: props.backgroundAgentSource,
    featureFlags: props.featureFlags,
    modelInfo: props.modelInfo,
    toolInfo: props.toolInfo,
    formattingOptions: {
      shouldUseFormatCodeblock: true,
      gpt5StyleLineNumbers: false,
      gpt5CodexCatN: false,
      enableLineNumbers: true,
    },
    nameWeTellTheModelToCallItself: "Slate",
    enableComputerUse,
  }
  return { testingPromptProps, enableComputerUse, browserTools: props.browserTools }
}

const TestingInstructions2Prompt = TestingInstructions2 as unknown as (props: Record<string, unknown>) => PromptNode
const ComputerUseInstructionsSectionPrompt = ComputerUseInstructionsSection as unknown as (props: Record<string, unknown>) => PromptNode

export function getCloudTestingSectionElements(
  props: CloudTestingSectionsProps,
  options?: CloudTestingSectionElementsOptions,
) {
  const context = getCloudSectionContext(props)
  if (context === undefined || props.toolInfo === undefined) return undefined
  return {
    gitAndSubmission: jsxs("section", {
      title: "git_and_submission",
      children: [
        jsx("h2", { children: "Git and submitting your work" }),
        jsx("ul", {
          children: GitOrNoRepositoryInstructions({
            isRepoless: props.isRepoless,
            gitInstructionsProps: {
              toolInfo: props.toolInfo,
              shouldShowTestingInstructions: true,
              suppressCreatedPrMention: isThreadBoundSession({
                isThreadSurface: props.isThreadSurface,
                sessionKind: projectThreadSessionKind(props.namedAgentSessionKind),
              }),
            },
          }),
        }),
      ],
    }),
    testing: jsx(TestingInstructions2Prompt, {
      props: context.testingPromptProps,
      browserMcpProviderName: getBrowserMcpProviderName(context.browserTools),
      screenshotToolName: context.browserTools?.find(tool => tool.includes("browser_take_screenshot")),
      enableComputerUse: context.enableComputerUse,
      enableManualReproduction: context.enableComputerUse,
      computerUseSubagentName: "computerUse",
      omitTestingWorkflow: options?.omitTestingWorkflow === true,
    }),
    computerUse: context.enableComputerUse
      ? jsx(ComputerUseInstructionsSectionPrompt, { props: context.testingPromptProps })
      : undefined,
  }
}
