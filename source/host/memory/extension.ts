/** Declares the host capabilities the memory service needs. */

import { startMemoryExtension } from "./memory-extension-composition.ts"
import type { MemoryExtensionContext } from "./memory-extension-contracts.ts"

export type { MemoryExtensionContext } from "./memory-extension-contracts.ts"

export const memoryExtension = {
  id: "memory",
  dependencies: ["experiments", "inference", "telemetry"] as const,
  start(context: MemoryExtensionContext) {
    return startMemoryExtension(context)
  },
}
