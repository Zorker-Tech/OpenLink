import type { SubagentEntry, SubagentHandle } from "./subagent-registry-contracts.ts"

export class SubagentRegistryLinks {
  private readonly activeById = new Map<string, SubagentHandle>()
  private readonly ownerByToolCall = new Map<string, string>()

  add(id: string, handle: SubagentHandle, toolCallId?: string): void {
    this.activeById.set(id, handle)
    if (toolCallId !== undefined) this.ownerByToolCall.set(toolCallId, id)
  }

  remove(id: string): SubagentHandle | undefined {
    const handle = this.activeById.get(id)
    this.activeById.delete(id)
    for (const [toolCallId, owner] of this.ownerByToolCall) {
      if (owner === id) {
        this.ownerByToolCall.delete(toolCallId)
        break
      }
    }
    return handle
  }

  forCancellation(reference: string): SubagentEntry | undefined {
    const direct = this.activeById.get(reference)
    if (direct !== undefined) return { id: reference, handle: direct }

    const id = this.ownerByToolCall.get(reference)
    if (id === undefined) return undefined
    const handle = this.activeById.get(id)
    this.ownerByToolCall.delete(reference)
    return handle === undefined ? undefined : { id, handle }
  }

  ownerIdsForToolCalls(toolCallIds: ReadonlySet<string>): ReadonlySet<string> {
    const owners = new Set<string>()
    for (const callId of toolCallIds) {
      const id = this.ownerByToolCall.get(callId)
      if (id !== undefined) owners.add(id)
    }
    return owners
  }

  get(id: string): SubagentHandle | undefined {
    return this.activeById.get(id)
  }

  has(id: string): boolean {
    return this.activeById.has(id)
  }

  entries(): SubagentEntry[] {
    return [...this.activeById].map(([id, handle]) => ({ id, handle }))
  }

  get size(): number {
    return this.activeById.size
  }
}
