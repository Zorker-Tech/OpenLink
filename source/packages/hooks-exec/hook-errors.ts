/**
 * What an agent is told when a hook blocks it, or when hooks cannot be evaluated at all.
 *
 * Hooks are user- or team-configured commands that decide whether an action may run, so a block is
 * deliberate policy rather than a failure — and the agent has to be told that plainly, or it will
 * spend the turn looking for a way around it. The opposite case is a hook that cannot run: there the
 * action is blocked too, but because nothing could decide, which is why the message says so and points
 * at where hooks are configured.
 */

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

/** Runs an action whose failure to evaluate must block it: hooks decide, so silence is a refusal. */
export async function withFailClosed<T>(
  fn: () => T | Promise<T>,
  actionDescription: string | null | undefined,
): Promise<T> {
  try {
    return await fn()
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    throw new FailClosedError(createHookFailClosedMessage(actionDescription, errorMessage), error)
  }
}

export const HOOK_SETTINGS_HINT = "To view or modify configured hooks, go to Slate Settings > Hooks."
export const HOOK_DENIAL_AGENT_NOTE = "Agent note: Do not suggest workarounds to the blocked tool."

export function appendAgentDenialNote(message: string): string {
  if (message.includes(HOOK_DENIAL_AGENT_NOTE)) return message
  return `${message}\n\n${HOOK_DENIAL_AGENT_NOTE}`
}

export function createHookDenialMessage(
  actionDescription: string,
  userMessage: string | null | undefined,
): string {
  const base = userMessage
    ? `${actionDescription} was blocked by a hook: ${userMessage}`
    : `${actionDescription} was blocked by a hook.`
  return appendAgentDenialNote(`${base}\n\n${HOOK_SETTINGS_HINT}`)
}

export function createHookFailClosedMessage(
  actionDescription: string | null | undefined,
  errorMessage: string | null | undefined,
): string {
  const action = actionDescription ?? "Action"
  const errorDetail = errorMessage ? `: ${errorMessage}` : "."
  const base = `${action} was blocked because a configured hook failed to execute${errorDetail}\n\nThis is a safety measure (fail-closed) - when hooks cannot be evaluated, the action is blocked to prevent potentially unsafe operations.`
  return `${base}\n\n${HOOK_SETTINGS_HINT}`
}
