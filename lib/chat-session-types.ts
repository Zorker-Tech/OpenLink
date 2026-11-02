export type AgentKind = 'codex' | 'pi' | 'omp'

export interface ChatSessionSummary {
  id: string
  userId: string
  title: string
  updatedAt: string
  projectId: string
  projectName: string
  projectIsDefault: boolean
  agent?: AgentKind
  labels?: string[]
  /** Latest durable execution state; the sidebar does not infer this from the active tab. */
  runStatus?: 'idle' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'
  runProcessId?: string
  runStartedAt?: string
}
