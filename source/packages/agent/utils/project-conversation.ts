/**
 * What a conversation is, from its turns.
 *
 * A conversation can be a project's own, a subagent's, or a side chat's, and the difference matters
 * when the agent decides which instructions apply. The answer is not on the conversation but in its
 * turns: the newest turn that draws a project boundary decides, and turns that the platform simulated
 * (a reminder, a notification) are skipped rather than mistaken for the user's own.
 */

import { isRootProjectDetails } from "../../constants/project-conversation.ts"
import type { Context } from "../../context/context.ts"
import type { AgentMode } from "../../proto/generated/agent/v1/agent_pb.ts"
import { AgentMode as AgentModeValues } from "../../proto/generated/agent/v1/agent_pb.ts"
import { AgentType } from "./agent-config.ts"

interface ProjectUserMessage {
  readonly projectDetails?: Parameters<typeof isRootProjectDetails>[0]
  readonly bestOfNGroupId?: unknown
  readonly mode?: AgentMode
  readonly isSimulatedMsg?: boolean
}

interface ProjectConversationTurn {
  get(ctx: Context): Promise<{
    readonly userMessage?: { get(ctx: Context): Promise<ProjectUserMessage> }
    readonly [key: string]: unknown
  }>
}

interface ProjectConversationState {
  readonly turns: readonly ProjectConversationTurn[]
}

/** A project's own message: it belongs to the project and was not one of a best-of-N group. */
export function isRootProjectUserMessage(userMessage: ProjectUserMessage): boolean {
  return isRootProjectDetails(userMessage.projectDetails) && userMessage.bestOfNGroupId === undefined
}

/** Whether the cloud-worker procedure is left out: only for an unnamed background agent in a project. */
export function shouldOmitCloudWorkerProcedure({
  gateEnabled,
  agentType,
  mode,
  useLocalAgentPrompting,
  isNamedAgentSession,
  isRootProject,
}: {
  readonly gateEnabled: boolean
  readonly agentType: AgentType
  readonly mode: AgentMode
  readonly useLocalAgentPrompting: boolean
  readonly isNamedAgentSession: boolean
  readonly isRootProject: boolean
}): boolean {
  return gateEnabled &&
    agentType === AgentType.BACKGROUND &&
    mode === AgentModeValues.AGENT &&
    !useLocalAgentPrompting &&
    !isNamedAgentSession &&
    isRootProject
}

export async function resolveProjectConversationContext(
  ctx: Context,
  stateHandler: ProjectConversationState,
): Promise<{
  lastMode: AgentMode | undefined
  isRootProject: boolean
  hasProjectBoundary: boolean
}> {
  let lastMode: AgentMode | undefined
  for (let index = stateHandler.turns.length - 1; index >= 0; index--) {
    const turn = await stateHandler.turns[index]!.get(ctx)
    if (!("userMessage" in turn)) continue
    const userMessage = await turn.userMessage!.get(ctx)
    lastMode ??= userMessage.mode
    const hasProjectBoundary =
      userMessage.projectDetails !== undefined || userMessage.bestOfNGroupId !== undefined
    if (hasProjectBoundary) {
      return { lastMode, isRootProject: isRootProjectUserMessage(userMessage), hasProjectBoundary: true }
    }
    if (userMessage.isSimulatedMsg !== true) break
  }
  return { lastMode, isRootProject: false, hasProjectBoundary: false }
}
