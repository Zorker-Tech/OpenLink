import type { RemoteExecManager } from "../../agent-exec/executor-resources.ts"
import { createResource, type ControlledExecManager } from "../../agent-exec/resource-provider.ts"
import { SubagentRegistryLinks } from "./subagent-registry-links.ts"
import { excludedSubagentCalls, type SubagentHandle } from "./subagent-registry-contracts.ts"

export type { SubagentHandle } from "./subagent-registry-contracts.ts"

export class SubagentRegistry {
  private readonly links = new SubagentRegistryLinks()
  private abortOptions: unknown

  get lastAbortOptions(): unknown {
    return this.abortOptions
  }

  register(id: string, handle: SubagentHandle, toolCallId?: string): void {
    const previous = this.links.remove(id)
    previous?.cancel()
    this.links.add(id, handle, toolCallId)
  }

  cancel(id: string, options?: unknown): void {
    this.abortOptions = options
    const selected = this.links.forCancellation(id)
    if (selected === undefined) return

    try {
      selected.handle.cancel(options)
    } finally {
      this.links.remove(selected.id)
    }
  }

  cleanup(id: string): void {
    this.links.remove(id)
  }

  get(id: string): SubagentHandle | undefined {
    return this.links.get(id)
  }

  has(id: string): boolean {
    return this.links.has(id)
  }

  get size(): number {
    return this.links.size
  }

  cancelAll(options?: unknown): void {
    this.abortOptions = options
    const excludedIds = this.links.ownerIdsForToolCalls(excludedSubagentCalls(options))
    const targets = this.links.entries().filter(({ id }) => !excludedIds.has(id))

    for (const { id } of targets) this.links.remove(id)
    for (const { handle } of targets) {
      try {
        handle.cancel(options)
      } catch {
      }
    }
  }
}

export const subagentRegistryResource = createResource<
  SubagentRegistry,
  RemoteExecManager,
  ControlledExecManager
>(
  (_remoteExecManager) => new SubagentRegistry(),
  (_implementation, _controlledExecManager) => {},
)
