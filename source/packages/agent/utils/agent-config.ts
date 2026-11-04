/**
 * What kind of agent this is, and what it is therefore allowed to do.
 *
 * The same agent code runs in an editor, from a terminal, and as a background cloud worker, and the
 * differences are decided here: which command-classification results become proto, whether the cloud
 * behaviours apply, whether the agent may use the computer (a screenshot-and-click loop), and whether
 * an environment is one where that makes sense at all (an automated fix job is not).
 */

import type { BackgroundAgentSource } from "./agent-config-contracts.ts"

export type {
  BackgroundAgentSource,
  CommandClassifierInternalResult,
  CommandClassifierSucceededResult,
} from "./agent-config-contracts.ts"

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

export const AgentType = {
  IDE: "ide",
  CLI: "cli",
  BACKGROUND: "background",
  BUGBOT: "bug_report",
} as const

export type AgentType = (typeof AgentType)[keyof typeof AgentType]

export const shouldUseExperimentalCloudBehavior = (props: {
  readonly enableCloudTesting?: boolean | undefined
  readonly agentType?: AgentType | undefined
}): boolean => props.enableCloudTesting === true && props.agentType === AgentType.BACKGROUND

export function isCloudAgentComputerUseEligibleEnvironment(
  backgroundAgentSource: BackgroundAgentSource | undefined,
): boolean {
  return backgroundAgentSource !== "automated-fix"
}

export function isCloudAgentTestingPromptEligibleEnvironment(
  backgroundAgentSource: BackgroundAgentSource | undefined,
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
  readonly backgroundAgentSource?: BackgroundAgentSource | undefined
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
