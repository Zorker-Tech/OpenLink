export interface WorkspacePreviewState {
  version: 1
  selectedProjectId: string | null
  targetIds: Record<string, string>
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
