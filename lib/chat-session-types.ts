export type AgentKind = 'codex' | 'pi'

export interface ChatSessionSummary {
  id: string
  userId: string
  title: string
  updatedAt: string
  projectId: string
  projectName: string
  projectIsDefault: boolean
  agent?: AgentKind
}
