/** Provides host paths, debounce policy and the production synthesis worker to the memory extension. */

import { createRealDebouncePolicy } from "../extensions/scheduling.ts"
import { getSlateAgentsRootDir } from "../storage/agent-paths.ts"
import { getSlateRootDir } from "../host-paths.ts"
import { MEMORY_CHANGE_DEBOUNCE_MS, type MemoryService } from "./memory-service.ts"
import type { MemoryExtensionContext } from "./memory-extension-contracts.ts"
import type { MemoryProductionContext } from "./memory-production-contracts.ts"
import { createMemorySynthesisProductionService } from "./memory-synthesis-production.ts"

export function createMemoryProductionExtras(
  context: MemoryProductionContext,
): Omit<MemoryExtensionContext, "deps" | "onStop"> {
  return {
    slateRoot: getSlateRootDir(),
    agentsRootDir: getSlateAgentsRootDir(),
    debounce: createRealDebouncePolicy({
      name: "slate-memory-change",
      delayMs: MEMORY_CHANGE_DEBOUNCE_MS,
    }),
    createSynthesis: (memory: MemoryService) => createMemorySynthesisProductionService(context, memory),
  }
}
