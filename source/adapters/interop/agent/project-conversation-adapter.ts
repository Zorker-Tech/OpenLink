/** Translates persisted conversation messages into Slate's project-context contract. */

import { AgentMode } from "../proto/generated/agent/v1/agent_pb.ts"
import type { Context } from "../../../packages/context/context.ts"
import { ProjectConversationBoundary } from "../../../packages/constants/project-conversation.ts"
import { SlateMode, type SlateMode as SlateModeValue } from "../../../packages/agent/mode-processing.ts"
import {
  isRootProjectUserMessage,
  resolveProjectConversationContext,
  shouldOmitCloudWorkerProcedure,
  type ProjectConversationMessage,
  type ProjectConversationState,
} from "../../../packages/agent/utils/project-conversation.ts"
import { AgentType } from "../../../packages/agent/utils/agent-config.ts"
import { fromInteropAgentMode, toInteropAgentMode } from "./mode-processing-adapter.ts"

interface InteropProjectDetails {
  readonly subagent?: unknown
  readonly sideChat?: unknown
}

interface InteropProjectUserMessage {
  readonly projectDetails?: InteropProjectDetails | null | undefined
  readonly bestOfNGroupId?: string | undefined
  readonly mode?: AgentMode | undefined
  readonly isSimulatedMsg?: boolean | undefined
}

interface InteropProjectConversationTurn {
  get(ctx: Context): Promise<{
    readonly userMessage?: { get(ctx: Context): Promise<InteropProjectUserMessage> } | undefined
  }>
}

export interface InteropProjectConversationState {
  readonly turns: readonly InteropProjectConversationTurn[]
}

function isRootProjectDetails(details: InteropProjectUserMessage["projectDetails"]): boolean {
  return details != null && details.subagent === undefined && details.sideChat === undefined
}

function toSlateProjectConversationMessage(message: InteropProjectUserMessage): ProjectConversationMessage {
  const hasBoundary = message.projectDetails !== undefined || message.bestOfNGroupId !== undefined
  const projectBoundary = hasBoundary
    ? message.bestOfNGroupId === undefined && isRootProjectDetails(message.projectDetails)
      ? ProjectConversationBoundary.ROOT
      : ProjectConversationBoundary.RELATED
    : undefined
  const mode = fromInteropAgentMode(message.mode)

  return {
    ...(projectBoundary === undefined ? {} : { projectBoundary }),
    ...(mode === undefined ? {} : { mode }),
    isSimulated: message.isSimulatedMsg === true,
  }
}

export function isRootProjectUserMessageFromInterop(message: InteropProjectUserMessage): boolean {
  return isRootProjectUserMessage(toSlateProjectConversationMessage(message))
}

export function shouldOmitCloudWorkerProcedureFromInterop({
  mode,
  ...policy
}: {
  readonly gateEnabled: boolean
  readonly agentType: AgentType
  readonly mode: AgentMode
  readonly useLocalAgentPrompting: boolean
  readonly isNamedAgentSession: boolean
  readonly isRootProject: boolean
}): boolean {
  return shouldOmitCloudWorkerProcedure({
    ...policy,
    mode: fromInteropAgentMode(mode) ?? SlateMode.UNSPECIFIED,
  })
}

export async function resolveSlateProjectConversationContextFromInterop(
  ctx: Context,
  state: InteropProjectConversationState,
): Promise<{
  lastMode: SlateModeValue | undefined
  isRootProject: boolean
  hasProjectBoundary: boolean
}> {
  const normalizedState: ProjectConversationState = {
    turns: state.turns.map(turn => ({
      get: async turnContext => {
        const turnView = await turn.get(turnContext)
        const userMessage = turnView.userMessage
        if (userMessage === undefined) return {}
        return {
          userMessage: {
            get: async messageContext => toSlateProjectConversationMessage(await userMessage.get(messageContext)),
          },
        }
      },
    })),
  }

  return resolveProjectConversationContext(ctx, normalizedState)
}

export async function resolveProjectConversationContextFromInterop(
  ctx: Context,
  state: InteropProjectConversationState,
): Promise<{
  lastMode: AgentMode | undefined
  isRootProject: boolean
  hasProjectBoundary: boolean
}> {
  const context = await resolveSlateProjectConversationContextFromInterop(ctx, state)
  return {
    ...context,
    lastMode: context.lastMode === undefined ? undefined : toInteropAgentMode(context.lastMode),
  }
}

export function isProjectConversationModeFromInterop(mode: number | undefined): boolean {
  return fromInteropAgentMode(mode) === SlateMode.PROJECT
}
