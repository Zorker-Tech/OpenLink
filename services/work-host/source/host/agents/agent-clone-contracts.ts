export interface AgentCloneAdapters {
  getAutomationsDir(agentDir: string): string
  checkpointStore(path: string): void
  rewriteIdentity(targetDir: string, newAgentId: string, includesChatHistory: false): void
}
