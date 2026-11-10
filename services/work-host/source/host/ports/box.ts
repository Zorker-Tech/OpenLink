export const SLATE_BOX_NOT_READY_MESSAGE = "The computer is still starting up (downloading its image or booting). Try again in a moment."
export const SLATE_BOX_NOT_RESPONDING_MESSAGE = "The computer isn't responding — it may be wedged. Try again in a moment, or recover it from Settings → Updates → Update Slate's Computer."
export const SLATE_BOX_NO_MONITOR_AVAILABLE_MESSAGE = "Every desktop monitor on the shared computer is in use right now, so this agent can't get its own screen. Wait a moment and try again — one frees up when another agent or parallel computer-use subagent finishes."

const DAEMON_OUTCOMES_THAT_NEED_RECOVERY = new Set(["timeout", "crash"])

export class SlateBoxDaemonUnreachableError extends Error {
  constructor(readonly outcome: string, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "SlateBoxDaemonUnreachableError"
  }
}

export class SlateBoxNoMonitorAvailableError extends Error {
  constructor(message = "No private desktop monitor is available on the shared box.") {
    super(message)
    this.name = "SlateBoxNoMonitorAvailableError"
  }
}

function daemonNeedsRecoveryHint(error: unknown): boolean {
  return error instanceof SlateBoxDaemonUnreachableError && DAEMON_OUTCOMES_THAT_NEED_RECOVERY.has(error.outcome)
}

export function boxNotReadyMessageForError(error: unknown): string {
  if (error instanceof SlateBoxNoMonitorAvailableError) return SLATE_BOX_NO_MONITOR_AVAILABLE_MESSAGE
  return daemonNeedsRecoveryHint(error) ? SLATE_BOX_NOT_RESPONDING_MESSAGE : SLATE_BOX_NOT_READY_MESSAGE
}

async function rejectComputerUseWithoutMonitor(): Promise<never> {
  throw new SlateBoxNoMonitorAvailableError()
}

export const noMonitorComputerUseExecutor = {
  execute: rejectComputerUseWithoutMonitor,
}

export function isNoMonitorComputerUseExecutor(executor: unknown): boolean {
  return executor === noMonitorComputerUseExecutor
}

export const SLATE_BOX_PRIMARY_WINDOW_INDEX = 1
export const SLATE_BOX_FIRST_FORK_WINDOW_INDEX = 2

export function isPrimaryWindowIndex(windowIndex: number): boolean {
  return windowIndex < SLATE_BOX_FIRST_FORK_WINDOW_INDEX
}

export class BoxEnvironmentSyncUnsupportedError extends Error {
  constructor() {
    super("This box does not support environment sync.")
    this.name = "BoxEnvironmentSyncUnsupportedError"
  }
}

export class BoxMcpUnsupportedError extends Error {
  constructor() {
    super("This box does not support running MCP servers.")
    this.name = "BoxMcpUnsupportedError"
  }
}
