import { BackgroundComposerSource } from "../proto/generated/aiserver/v1/background_composer_pb.ts"
import type { BackgroundAgentSource } from "../../../packages/agent/utils/agent-config-contracts.ts"

/** Collapse the host's source enum into the three distinctions used by Slate agent policy. */
export function projectBackgroundAgentSource(source: unknown): BackgroundAgentSource | undefined {
  if (source === undefined || source === null) return undefined
  if (source === BackgroundComposerSource.CLOUD_META_AGENT) return "named-agent"
  if (
    source === BackgroundComposerSource.GITHUB_CI_AUTOFIX ||
    source === BackgroundComposerSource.BUGBOT_AUTOFIX
  ) {
    return "automated-fix"
  }
  return "other"
}
