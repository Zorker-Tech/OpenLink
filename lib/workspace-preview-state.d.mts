export interface WorkspacePreviewState {
  version: 3
  selectedProjectId: string | null
  targetIds: Record<string, string>
  pagePaths: Record<string, string>
  viewportModes: Record<string, 'browser' | 'mobile'>
}

export function createEmptyWorkspacePreviewState(): WorkspacePreviewState
export function sanitizeWorkspacePreviewState(value: unknown, allowedProjectIds: readonly string[]): WorkspacePreviewState
export function loadWorkspacePreviewState(
  userId: string,
  workspaceId: string,
  allowedProjectIds: readonly string[],
  storage?: Pick<Storage, 'getItem'> | null,
): WorkspacePreviewState | null
export function saveWorkspacePreviewState(
  userId: string,
  workspaceId: string,
  state: unknown,
  allowedProjectIds: readonly string[],
  storage?: Pick<Storage, 'setItem'> | null,
): boolean
