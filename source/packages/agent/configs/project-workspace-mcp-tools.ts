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

import { AgentMode } from "../../proto/generated/agent/v1/agent_pb.ts"
import type { Context } from "../../context/context.ts"
import { resolveProjectConversationContext } from "../utils/project-conversation.ts"
import { filterProjectWorkspaceMutationMcpDescriptors } from "../prompts/mcp-catalog.ts"

interface ProjectWorkspaceState {
  readonly mode?: AgentMode | undefined
  readonly turns?: readonly {
    get(ctx: Context): Promise<unknown>
  }[]
}

export async function isProjectWorkspaceConversation(
  ctx: Context,
  stateHandler: ProjectWorkspaceState,
): Promise<boolean> {
  if (stateHandler.mode === AgentMode.PROJECT) return true
  if (!("turns" in stateHandler)) return false
  return (await resolveProjectConversationContext(
    ctx,
    stateHandler as Parameters<typeof resolveProjectConversationContext>[1],
  )).isRootProject
}

export { filterProjectWorkspaceMutationMcpDescriptors }
