/**
 * The subagents a conversation has running, and how they are stopped.
 *
 * A subagent is started by a tool call and lives outside the turn that started it, so the conversation
 * has to keep track of it in two directions: by its own id, and by the tool call that spawned it —
 * because the two are what different callers have in hand. A subagent registered twice replaces the
 * previous one and cancels it, since two live subagents under one id would be one too many.
 *
 * Cancelling takes either id, and a cancel that throws still forgets the subagent: the alternative is a
 * registry that keeps a handle to something that is already gone. Cancelling everything honours an
 * exclusion list of tool calls, which is how a caller stops the work it started without stopping work
 * someone else started.
 */

import { createResource } from "../../agent-exec/resource-provider.ts"

type Any = any

export interface SubagentHandle {
  cancel(options?: Any): void
}

export class SubagentRegistry {
  private readonly subagents = new Map<string, SubagentHandle>()
  private readonly toolCallIdToSubagentId = new Map<string, string>()
  private _lastAbortOptions: Any

  get lastAbortOptions(): Any {
    return this._lastAbortOptions
  }

  register(id: string, handle: SubagentHandle, toolCallId?: string): void {
    if (this.subagents.has(id)) {
      // One live subagent per id: the previous one is cancelled rather than orphaned.
      const previous = this.subagents.get(id)
      this.subagents.delete(id)
      for (const [mappedToolCallId, subagentId] of this.toolCallIdToSubagentId) {
        if (subagentId === id) {
          this.toolCallIdToSubagentId.delete(mappedToolCallId)
          break
        }
      }
      previous?.cancel()
    }
    this.subagents.set(id, handle)
    if (toolCallId !== undefined) this.toolCallIdToSubagentId.set(toolCallId, id)
  }

  cancel(id: string, options?: Any): void {
    this._lastAbortOptions = options
    let handle = this.subagents.get(id)
    let subagentIdToDelete = id
    if (handle === undefined) {
      // The caller may be holding the tool call id instead of the subagent's own id.
      const subagentId = this.toolCallIdToSubagentId.get(id)
      if (subagentId !== undefined) {
        handle = this.subagents.get(subagentId)
        subagentIdToDelete = subagentId
        this.toolCallIdToSubagentId.delete(id)
      }
    }
    if (handle !== undefined) {
      try {
        handle.cancel(options)
      } finally {
        this.subagents.delete(subagentIdToDelete)
        for (const [toolCallId, subagentId] of this.toolCallIdToSubagentId) {
          if (subagentId === subagentIdToDelete) {
            this.toolCallIdToSubagentId.delete(toolCallId)
            break
          }
        }
      }
    }
  }

  cleanup(id: string): void {
    this.subagents.delete(id)
    for (const [toolCallId, subagentId] of this.toolCallIdToSubagentId) {
      if (subagentId === id) {
        this.toolCallIdToSubagentId.delete(toolCallId)
        break
      }
    }
  }

  get(id: string): SubagentHandle | undefined {
    return this.subagents.get(id)
  }

  has(id: string): boolean {
    return this.subagents.has(id)
  }

  get size(): number {
    return this.subagents.size
  }

  cancelAll(options?: Any): void {
    this._lastAbortOptions = options
    const excludedToolCallIds = new Set<string>((options?.excludeToolCallIds ?? []) as string[])
    const excludedSubagentIds = new Set<string>()
    for (const toolCallId of excludedToolCallIds) {
      const subagentId = this.toolCallIdToSubagentId.get(toolCallId)
      if (subagentId !== undefined) excludedSubagentIds.add(subagentId)
    }
    const entries = Array.from(this.subagents.entries()).filter(([subagentId]) => !excludedSubagentIds.has(subagentId))
    // Forget first, then cancel: a cancel that throws must not leave the registry holding a dead handle.
    for (const [subagentId] of entries) {
      this.subagents.delete(subagentId)
      for (const [toolCallId, mappedSubagentId] of this.toolCallIdToSubagentId) {
        if (mappedSubagentId === subagentId) {
          this.toolCallIdToSubagentId.delete(toolCallId)
          break
        }
      }
    }
    for (const [, handle] of entries) {
      try {
        handle.cancel(options)
      } catch {
      }
    }
  }
}

export const subagentRegistryResource = createResource(
  (_remoteExecManager: Any) => new SubagentRegistry(),
  (_implementation: SubagentRegistry, _controlledExecManager: Any) => {},
)
