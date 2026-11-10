/**
 * Whether a session may hand a video to the subagent that watches them.
 *
 * Watching a video costs a great deal of context, so it is not offered everywhere: a desktop session
 * needs the feature turned on for it explicitly, while a background session started from a chat surface
 * or an automation may use it once video attachments are enabled there at all. Everywhere else the
 * attachment is left to the ordinary file tools.
 */

import { AgentType } from "../utils/agent-config.ts"

export type SlateBackgroundAgentSource = "chat" | "automation" | "other"

export interface WatchVideoEligibilityInput {
  readonly agentType: AgentType | undefined
  readonly backgroundAgentSource: SlateBackgroundAgentSource | undefined
  readonly featureFlags?: {
    readonly enableBackgroundVideoAttachments?: boolean | undefined
    readonly enableWatchVideoInIdeSubagent?: boolean | undefined
  } | undefined
}

export function canUseWatchVideoSubagent(input: WatchVideoEligibilityInput): boolean {
  if (input.agentType === AgentType.IDE) {
    return input.featureFlags?.enableWatchVideoInIdeSubagent === true
  }
  if (input.agentType !== AgentType.BACKGROUND) return false

  const supportedSource = input.backgroundAgentSource === "chat" || input.backgroundAgentSource === "automation"
  return supportedSource && input.featureFlags?.enableBackgroundVideoAttachments === true
}
