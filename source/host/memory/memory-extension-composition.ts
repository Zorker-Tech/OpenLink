/** Builds the memory service, its gated synthesis worker, and each agent's memory state. */

import { AgentProjectMembershipStore } from "./project-membership.ts"
import { createSlateAgentState, type AgentStateDeps } from "./agent-state.ts"
import { MemoryService } from "./memory-service.ts"
import type { MemoryExtensionContext } from "./memory-extension-contracts.ts"

type AgentStateForExtension = Omit<AgentStateDeps, "slateRoot" | "membership"> & {
  readonly agentDir: string
}

export function startMemoryExtension(context: MemoryExtensionContext) {
  const service = new MemoryService({
    slateRoot: context.slateRoot,
    agentsRootDir: context.agentsRootDir,
    debounce: context.debounce,
  })

  const onSynthesisGateChanged = (enabled: boolean): void => {
    if (!enabled) {
      context.deps.telemetry.logs.reportMemorySynthesis({ outcome: "skipped_gate" })
      return
    }
    service.enableMemorySynthesis(context.createSynthesis(service))
  }
  context.deps.experiments.pinGateOnAuthenticatedBootstrap("slate_memory_dreaming", onSynthesisGateChanged)
  context.onStop(() => service.dispose())

  return Object.assign(service, {
    createAgentState: (options: AgentStateForExtension) => createSlateAgentState({
      ...options,
      slateRoot: context.slateRoot,
      membership: new AgentProjectMembershipStore(options.agentDir),
    }),
  })
}
