import { AgentMode } from "../proto/generated/agent/v1/agent_pb.ts"
import type { AgentNotesPromptInput } from "../../../packages/agent/context/agent-notes-context.ts"

export type CounterpartAgentNotesInput = Omit<AgentNotesPromptInput, "isProjectConversation"> & {
  readonly mode: AgentMode
}

export function toAgentNotesPromptInput(input: CounterpartAgentNotesInput): AgentNotesPromptInput {
  const { mode, ...notes } = input
  return {
    ...notes,
    isProjectConversation: mode === AgentMode.PROJECT,
  }
}
