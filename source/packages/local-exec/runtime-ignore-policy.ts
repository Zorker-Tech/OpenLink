/** Default workspace visibility when no ignore-list source is configured. */
export class EmptyWorkspaceIgnorePolicy {
  async isCursorIgnored(_path: string): Promise<boolean> { return false }
  async isGitIgnored(_path: string): Promise<boolean> { return false }
  async isIgnoredByAny(_path: string): Promise<boolean> { return false }
  async listCursorIgnoreFilesByRoot(_root: string): Promise<never[]> { return [] }
  async isRepoBlocked(_path: string): Promise<boolean> { return false }
  async getWorkspaceIgnoreMapping(): Promise<Record<string, never>> { return {} }
  async getCursorIgnoreMapping(): Promise<Record<string, never>> { return {} }
  async getGitIgnoreMapping(): Promise<Record<string, never>> { return {} }
  async getRepoBlockExcludeGlobs(_root: string): Promise<never[]> { return [] }
}
