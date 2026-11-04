import { BackgroundComposerSource } from "../proto/generated/aiserver/v1/background_composer_pb.ts";
import type { SlateBackgroundAgentSource } from "../../../packages/agent/context/watch-video-eligibility.ts";

/** Reduces the scheduler's source enum to the values the video policy understands. */
export function backgroundSourceForVideoPolicy(
  source: unknown,
): SlateBackgroundAgentSource | undefined {
  switch (source) {
    case BackgroundComposerSource.SLACK: return "chat";
    case BackgroundComposerSource.AUTOMATIONS: return "automation";
    case BackgroundComposerSource.UNSPECIFIED:
    case undefined:
    default:
      return undefined;
  }
}
