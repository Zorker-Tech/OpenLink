/** Error identities and user-facing explanations for hooks that deny or fail to decide. */

export class HookDeniedError extends Error {
  readonly failureType = "permission_denied"
  override readonly name = "HookDeniedError"
  readonly reason: string

  constructor(reason: string) {
    super(`Hook denied: ${reason}`)
    this.reason = reason
  }
}

export class FailClosedError extends Error {
  readonly failureType = "error"
  override readonly name = "FailClosedError"
  readonly reason: string
  override readonly cause: unknown

  constructor(reason: string, cause: unknown) {
    super(`Hook failed (fail-closed): ${reason}`)
    this.reason = reason
    this.cause = cause
  }
}

export const HOOK_SETTINGS_HINT = "To view or modify configured hooks, go to Slate Settings > Hooks."
export const HOOK_DENIAL_AGENT_NOTE = "Agent note: Do not suggest workarounds to the blocked tool."

export async function withFailClosed<T>(
  evaluate: () => T | Promise<T>,
  actionDescription: string | null | undefined,
): Promise<T> {
  try {
    const decision = await evaluate()
    return decision
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    throw new FailClosedError(createHookFailClosedMessage(actionDescription, detail), cause)
  }
}

export function appendAgentDenialNote(message: string): string {
  return message.includes(HOOK_DENIAL_AGENT_NOTE)
    ? message
    : `${message}\n\n${HOOK_DENIAL_AGENT_NOTE}`
}

export function createHookDenialMessage(
  actionDescription: string,
  userMessage: string | null | undefined,
): string {
  const decision = userMessage
    ? `${actionDescription} was blocked by a hook: ${userMessage}`
    : `${actionDescription} was blocked by a hook.`
  return appendAgentDenialNote(`${decision}\n\n${HOOK_SETTINGS_HINT}`)
}

export function createHookFailClosedMessage(
  actionDescription: string | null | undefined,
  errorMessage: string | null | undefined,
): string {
  const subject = actionDescription ?? "Action"
  const cause = errorMessage ? `: ${errorMessage}` : "."
  const explanation = `${subject} was blocked because a configured hook failed to execute${cause}\n\nThis is a safety measure (fail-closed) - when hooks cannot be evaluated, the action is blocked to prevent potentially unsafe operations.`
  return `${explanation}\n\n${HOOK_SETTINGS_HINT}`
}
