/** Maps the persisted mode enum to Slate's notes-folder policy. */

import { AgentMode } from "../proto/generated/agent/v1/agent_pb.ts"
import type { MetaAgentNotesConfig } from "../../../packages/agent/actions/meta-agent-notes-contracts.ts"
import { buildSlateUserInfoAgentNotesProps } from "../../../packages/agent/actions/meta-agent-notes-policy.ts"
import { SlateMode } from "../../../packages/agent/mode-processing.ts"
import { fromInteropAgentMode } from "./mode-processing-adapter.ts"

export function buildUserInfoAgentNotesProps(
  config: MetaAgentNotesConfig,
  mode: AgentMode,
  env: {
    readonly agentConversationNotesFolder?: string | undefined
    readonly agentSharedNotesFolder?: string | undefined
  } | undefined,
): ReturnType<typeof buildSlateUserInfoAgentNotesProps> {
  return buildSlateUserInfoAgentNotesProps(
    config,
    fromInteropAgentMode(mode) ?? SlateMode.UNSPECIFIED,
    env,
  )
}
