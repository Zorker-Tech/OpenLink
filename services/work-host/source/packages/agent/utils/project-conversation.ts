/** Slate's project-conversation rules operate on owned, normalized turn data. */

import {
  ProjectConversationBoundary,
  type ProjectConversationBoundary as ProjectBoundary,
} from "../../constants/project-conversation.ts"
import type { Context } from "../../context/context.ts"
import { SlateMode, type SlateMode as SlateModeValue } from "../mode-processing.ts"
import { AgentType } from "./agent-config.ts"

export interface ProjectConversationMessage {
  readonly mode?: SlateModeValue | undefined
  readonly projectBoundary?: ProjectBoundary | undefined
  readonly isSimulated?: boolean | undefined
}

export interface ProjectConversationTurn {
  get(ctx: Context): Promise<{
    readonly userMessage?: { get(ctx: Context): Promise<ProjectConversationMessage> } | undefined
  }>
}

export interface ProjectConversationState {
  readonly turns: readonly ProjectConversationTurn[]
}

/** Root membership is assigned by the interop adapter from the incoming message's project markers. */
export function isRootProjectUserMessage(message: ProjectConversationMessage): boolean {
  return message.projectBoundary === ProjectConversationBoundary.ROOT
}

/** Only a background agent in the root project loses the cloud-worker procedure. */
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
  readonly mode: SlateModeValue
  readonly useLocalAgentPrompting: boolean
  readonly isNamedAgentSession: boolean
  readonly isRootProject: boolean
}): boolean {
  return gateEnabled &&
    agentType === AgentType.BACKGROUND &&
    mode === SlateMode.AGENT &&
    !useLocalAgentPrompting &&
    !isNamedAgentSession &&
    isRootProject
}

/** The most recent project boundary wins; simulated turns may be crossed, user turns may not. */
export async function resolveProjectConversationContext(
  ctx: Context,
  state: ProjectConversationState,
): Promise<{
  lastMode: SlateModeValue | undefined
  isRootProject: boolean
  hasProjectBoundary: boolean
}> {
  let newestMode: SlateModeValue | undefined

  for (let index = state.turns.length - 1; index >= 0; index--) {
    const turn = await state.turns[index]!.get(ctx)
    const messageHandle = turn.userMessage
    if (messageHandle === undefined) continue

    const message = await messageHandle.get(ctx)
    if (newestMode === undefined) newestMode = message.mode

    if (message.projectBoundary !== undefined) {
      return {
        lastMode: newestMode,
        isRootProject: isRootProjectUserMessage(message),
        hasProjectBoundary: true,
      }
    }

    if (message.isSimulated !== true) break
  }

  return { lastMode: newestMode, isRootProject: false, hasProjectBoundary: false }
}
