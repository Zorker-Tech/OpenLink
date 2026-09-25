/**
 * What kind of agent this is, and what it is therefore allowed to do.
 *
 * The same agent code runs in an editor, from a terminal, and as a background cloud worker, and the
 * differences are decided here: which command-classification results become proto, whether the cloud
 * behaviours apply, whether the agent may use the computer (a screenshot-and-click loop), and whether
 * an environment is one where that makes sense at all (an automated fix job is not).
 */

import { BackgroundComposerSource } from "../../proto/generated/aiserver/v1/background_composer_pb.ts"
import {
  CommandClassifierResult,
  CommandClassifierResult_ClassifiedCommand,
  CommandClassifierResult_SuggestedSandboxMode,
} from "../../proto/generated/agent/v1/shell_exec_pb.ts"

export class NoopWebScraperService {
  async getContentInWebsiteFast(_context: unknown, _url: unknown): Promise<null> {
    return null
  }
}

export class NoopDocumentationHydrationService {
  async hydrateDocumentation(
    _context: unknown,
    _documentationIdentifiers: unknown,
    _conversationQuery: unknown,
  ): Promise<{ chunks: never[]; customDocNotes: never[] }> {
    return { chunks: [], customDocNotes: [] }
  }
}

export type CommandClassifierSucceededResult = {
  readonly kind: "classification-succeeded"
  readonly suggestedSandboxMode: string
  readonly commands: readonly {
    readonly name: string
    readonly arguments: string[]
    readonly suggestedAllowlistEntry: string
    readonly subcommandTokens: string[]
  }[]
}

export type CommandClassifierInternalResult = CommandClassifierSucceededResult | { readonly kind: string }

/** The classifier's own shape becomes the proto the client reads; anything else is a failure. */
export function classifierResultToProto(
  result: CommandClassifierInternalResult,
): InstanceType<typeof CommandClassifierResult> {
  if (result.kind === "classification-succeeded") {
    const classified = result as CommandClassifierSucceededResult
    const suggestedSandboxMode = (() => {
      switch (classified.suggestedSandboxMode) {
        case "SANDBOX": return CommandClassifierResult_SuggestedSandboxMode.SANDBOX
        case "NO_SANDBOX": return CommandClassifierResult_SuggestedSandboxMode.NO_SANDBOX
        default: return CommandClassifierResult_SuggestedSandboxMode.UNDETERMINED
      }
    })()
    return new CommandClassifierResult({
      commands: classified.commands.map(command => new CommandClassifierResult_ClassifiedCommand({
        name: command.name,
        arguments: command.arguments,
        suggestedAllowlistEntry: command.suggestedAllowlistEntry,
        subcommandTokens: command.subcommandTokens,
      })),
      suggestedSandboxMode,
      classificationFailed: false,
    })
  }
  return new CommandClassifierResult({
    commands: [],
    suggestedSandboxMode: CommandClassifierResult_SuggestedSandboxMode.UNDETERMINED,
    classificationFailed: true,
  })
}

export const AgentType = {
  IDE: "ide",
  CLI: "cli",
  BACKGROUND: "background",
  BUGBOT: "bugbot",
} as const

export type AgentType = (typeof AgentType)[keyof typeof AgentType]

export const shouldUseExperimentalCloudBehavior = (props: {
  readonly enableCloudTesting?: boolean | undefined
  readonly agentType?: AgentType | undefined
}): boolean => props.enableCloudTesting === true && props.agentType === AgentType.BACKGROUND

export function isCloudAgentComputerUseEligibleEnvironment(
  backgroundAgentSource: BackgroundComposerSource | undefined,
): boolean {
  return backgroundAgentSource !== BackgroundComposerSource.GITHUB_CI_AUTOFIX &&
    backgroundAgentSource !== BackgroundComposerSource.BUGBOT_AUTOFIX
}

export function isCloudAgentTestingPromptEligibleEnvironment(
  backgroundAgentSource: BackgroundComposerSource | undefined,
): boolean {
  return isCloudAgentComputerUseEligibleEnvironment(backgroundAgentSource)
}

/** Models whose computer-use behaviour the platform has been built against. */
const COMPUTER_USE_ELIGIBLE_MODEL_PREFIXES = [
  "claude-4-sonnet",
  "claude-4.5-sonnet",
  "claude-4.5-haiku",
  "claude-4.5-opus",
]

export function isComputerUseEligibleModel(modelId: string): boolean {
  const lower = modelId.toLowerCase()
  return COMPUTER_USE_ELIGIBLE_MODEL_PREFIXES.some(
    prefix => lower === prefix || lower.startsWith(`${prefix}-`),
  )
}

export function shouldEnableComputerUse(props: {
  readonly agentType?: AgentType | undefined
  readonly isBackground?: boolean | undefined
  readonly enableCloudTesting?: boolean | undefined
  readonly backgroundAgentSource?: BackgroundComposerSource | undefined
  readonly modelId: string
}): boolean {
  if (props.agentType !== AgentType.BACKGROUND || props.isBackground !== true) return false
  if (!shouldUseExperimentalCloudBehavior({
    agentType: props.agentType,
    enableCloudTesting: props.enableCloudTesting,
  })) return false
  if (!isCloudAgentComputerUseEligibleEnvironment(props.backgroundAgentSource)) return false
  return isComputerUseEligibleModel(props.modelId)
}
