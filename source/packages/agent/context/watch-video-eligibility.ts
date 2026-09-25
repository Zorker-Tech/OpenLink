/**
 * Whether a session may hand a video to the subagent that watches them.
 *
 * Watching a video costs a great deal of context, so it is not offered everywhere: a desktop session
 * needs the feature turned on for it explicitly, while a background session started from a chat surface
 * or an automation may use it once video attachments are enabled there at all. Everywhere else the
 * attachment is left to the ordinary file tools.
 */

import { BackgroundComposerSource } from "../../proto/generated/aiserver/v1/background_composer_pb.ts"
import { AgentType } from "../utils/agent-config.ts"

export interface WatchVideoEligibilityInput {
  readonly agentType: AgentType | undefined
  readonly backgroundAgentSource: BackgroundComposerSource | undefined
  readonly featureFlags?: {
    readonly enableSlackVideoAttachments?: boolean | undefined
    readonly enableWatchVideoInIdeSubagent?: boolean | undefined
  } | undefined
}

export function canUseWatchVideoSubagent({
  agentType,
  backgroundAgentSource,
  featureFlags,
}: WatchVideoEligibilityInput): boolean {
  const backgroundAgentSupportsWatchVideo = agentType === AgentType.BACKGROUND &&
    (backgroundAgentSource === BackgroundComposerSource.SLACK ||
      backgroundAgentSource === BackgroundComposerSource.AUTOMATIONS) &&
    (featureFlags?.enableSlackVideoAttachments ?? false)
  return (agentType === AgentType.IDE && (featureFlags?.enableWatchVideoInIdeSubagent ?? false)) ||
    backgroundAgentSupportsWatchVideo
}
