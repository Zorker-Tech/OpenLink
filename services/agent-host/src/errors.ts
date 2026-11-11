export type AgentHostErrorCode =
  | 'INVALID_TARGET'
  | 'INVALID_POLICY'
  | 'INVALID_PATH'
  | 'INVALID_SESSION'
  | 'FRAME_TOO_LARGE'
  | 'INVALID_FRAME'
  | 'BACKEND_NOT_CONFIGURED'
  | 'BROWSER_SESSION_FAILED'
  | 'BROWSER_ACTION_FAILED'
  | 'PROVISIONING_FAILED'
  | 'PROJECT_BACKEND_UNAVAILABLE'
  | 'AUTH_REQUIRED'
  | 'AUTH_DENIED'
  | 'INVALID_BODY'
  | 'SESSION_BUSY'
  | 'SESSION_CLEANUP_FAILED'
  | 'EXTENSION_UI_UNAVAILABLE'
  | 'EXTENSION_UI_REQUEST_NOT_FOUND'
  | 'AGENT_TIMEOUT'
  | 'REQUEST_ABORTED'
  | 'PI_PROMPT_FAILED'
  | 'GIT_WORKTREE_DIRTY'
  | 'GIT_REF_INVALID'
  | 'GIT_CHECKOUT_FAILED'
  | 'GIT_SESSION_BINDING_CONFLICT'
  | 'PREVIEW_REVISION_UNAVAILABLE'
  | 'PREVIEW_START_COMMAND_UNAVAILABLE'
  | 'PREVIEW_DEPENDENCIES_UNAVAILABLE'
  | 'PREVIEW_START_FAILED'

export class AgentHostError extends Error {
  readonly code: AgentHostErrorCode
  readonly retryable: boolean

  constructor(code: AgentHostErrorCode, message: string, options?: { retryable?: boolean }) {
    super(message)
    this.name = 'AgentHostError'
    this.code = code
    this.retryable = options?.retryable ?? false
  }
}
