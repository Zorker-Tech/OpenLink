/** Stable self-state API assembled from memory, workflow, profile, project and avatar operations. */
import { createAgentAvatarOperations } from "./agent-state-avatar.ts";
import { createAgentMemoryOperations } from "./agent-state-memory.ts";
import { createAgentProfileOperations } from "./agent-state-profile.ts";
import { createAgentProjectOperations } from "./agent-state-projects.ts";
import { createAgentWorkflowOperations } from "./agent-state-workflows.ts";
import { AVATAR_MAX_BYTES, MEMORY_NOTE_PREFIX, type AgentStateDeps, type StateWriteResult } from "./agent-state-contracts.ts";

export { AVATAR_MAX_BYTES, MEMORY_NOTE_PREFIX };
export type { AgentStateDeps, StateWriteResult };

export function createSlateAgentState(deps: AgentStateDeps) {
  const now = deps.now ?? Date.now;
  return Object.assign(
    {},
    createAgentMemoryOperations(deps, now),
    createAgentWorkflowOperations(deps, now),
    createAgentProfileOperations(deps),
    createAgentProjectOperations(deps),
    createAgentAvatarOperations(deps),
  );
}
