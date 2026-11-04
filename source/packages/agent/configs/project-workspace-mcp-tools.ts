/**
 * Whether a conversation is a project's own, and what that takes away from it.
 *
 * A project conversation coordinates work across many turns and subagents, and one of the tools the
 * environment offers moves the agent to another root or creates a project — which is not something a
 * project conversation should be able to do to itself. So the descriptor is filtered before it reaches
 * the model, by the same filter the prompt layer uses.
 *
 * The conversation is recognized by its mode, or by resolving what it belongs to: a session whose root
 * turn is a project's is a project conversation whatever mode it is in.
 */

import type { Context } from "../../context/context.ts"
import {
  resolveProjectConversationContextFromInterop,
} from "../../../adapters/interop/agent/project-conversation-adapter.ts"
import { filterInteropProjectWorkspaceMutationMcpDescriptors } from "../../../adapters/interop/agent/project-workspace-mcp-adapter.ts"
import { SlateMode, type SlateMode as SlateModeValue } from "../mode-processing.ts"

interface ProjectWorkspaceState {
  readonly mode?: SlateModeValue | undefined
  readonly turns?: readonly {
    get(ctx: Context): Promise<unknown>
  }[]
}

export async function isProjectWorkspaceConversation(
  ctx: Context,
  stateHandler: ProjectWorkspaceState,
): Promise<boolean> {
  if (stateHandler.mode === SlateMode.PROJECT) return true
  if (!("turns" in stateHandler)) return false
  return (await resolveProjectConversationContextFromInterop(
    ctx,
    stateHandler as Parameters<typeof resolveProjectConversationContextFromInterop>[1],
  )).isRootProject
}

export { filterInteropProjectWorkspaceMutationMcpDescriptors as filterProjectWorkspaceMutationMcpDescriptors }
