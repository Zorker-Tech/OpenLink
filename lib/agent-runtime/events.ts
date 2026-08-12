export const AGENT_EVENT_VERSION = 1 as const

export type AgentEventSource = 'pi' | 'demo'

export interface AgentFileChange {
  path: string
  additions?: number
  deletions?: number
  /** A bounded Git patch captured inside the Project VM. */
  patch?: string
}

export type AgentFileEditOperation = 'write' | 'edit'

interface AgentEventBase {
  version: typeof AGENT_EVENT_VERSION
  id: string
  sequence: number
  sessionId: string
  timestamp: string
  source: AgentEventSource
}

interface AgentExecutionScope {
  taskId?: string
  partId?: string
}

type ScopedAgentEvent<T> = AgentEventBase & AgentExecutionScope & T

export type OpenLinkAgentEvent =
  | (AgentEventBase & { type: 'session.started' })
  | (AgentEventBase & { type: 'session.completed'; durationMs?: number })
  | (AgentEventBase & { type: 'message.user'; messageId: string; text: string })
  | (AgentEventBase & { type: 'message.delta'; messageId: string; delta: string })
  | (AgentEventBase & { type: 'message.completed'; messageId: string; text?: string })
  | (AgentEventBase & { type: 'reasoning.started'; reasoningId: string })
  | (AgentEventBase & { type: 'reasoning.delta'; reasoningId: string; delta: string })
  | (AgentEventBase & { type: 'reasoning.completed'; reasoningId: string; text?: string; durationMs?: number })
  | ScopedAgentEvent<{ type: 'tool.started'; toolId: string; name: string; input?: unknown }>
  | ScopedAgentEvent<{ type: 'tool.output'; toolId: string; output: string }>
  | ScopedAgentEvent<{ type: 'tool.completed'; toolId: string; output?: string }>
  | ScopedAgentEvent<{ type: 'tool.failed'; toolId: string; error: string }>
  | ScopedAgentEvent<{ type: 'command.started'; commandId: string; command: string }>
  | ScopedAgentEvent<{ type: 'command.output'; commandId: string; output: string }>
  | ScopedAgentEvent<{ type: 'command.completed'; commandId: string; output?: string; exitCode?: number }>
  | ScopedAgentEvent<{ type: 'file.editing.started'; editId: string; path: string; operation: AgentFileEditOperation; language?: string; content?: string }>
  | ScopedAgentEvent<{ type: 'file.editing.updated'; editId: string; path: string; operation: AgentFileEditOperation; language?: string; content?: string }>
  | ScopedAgentEvent<{ type: 'file.editing.completed'; editId: string; path: string; operation: AgentFileEditOperation; language?: string; content?: string }>
  | ScopedAgentEvent<{ type: 'file.editing.failed'; editId: string; path: string; operation: AgentFileEditOperation; language?: string; error: string; content?: string }>
  | ScopedAgentEvent<{ type: 'file.changed'; changeId: string; label: string; additions?: number; deletions?: number; files?: Array<string | AgentFileChange>; /** Full working-tree snapshot rather than tool-argument inference. */ snapshot?: boolean; baseCommit?: string }>
  | (AgentEventBase & { type: 'task.updated'; taskId: string; label: string; status: 'pending' | 'active' | 'completed' | 'failed'; detail?: string })
  | (AgentEventBase & { type: 'status.updated'; statusId: string; label: string; status: 'active' | 'completed' | 'failed'; detail?: string })
  | (AgentEventBase & { type: 'confirmation.requested'; confirmationId: string; title: string; message?: string; options?: string[]; inputKind?: 'confirm' | 'select' | 'input' | 'editor' })
  | (AgentEventBase & { type: 'confirmation.resolved'; confirmationId: string; approved: boolean; value?: string })
  | (AgentEventBase & { type: 'checkpoint.created'; checkpointId: string; label: string; metrics?: { actions?: number; credits?: number; model?: string } })
  | (AgentEventBase & { type: 'error'; errorId: string; message: string; recoverable?: boolean })

export function isOpenLinkAgentEvent(value: unknown): value is OpenLinkAgentEvent {
  if (!value || typeof value !== 'object') return false
  const event = value as Record<string, unknown>
  return event.version === AGENT_EVENT_VERSION
    && typeof event.id === 'string'
    && typeof event.sequence === 'number'
    && typeof event.sessionId === 'string'
    && typeof event.timestamp === 'string'
    && typeof event.source === 'string'
    && typeof event.type === 'string'
}
