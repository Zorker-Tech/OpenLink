/**
 * The box, as the rest of the host sees it: the errors it raises and the messages a user is shown.
 *
 * Which message a failure becomes depends on what happened — a monitor that is not available, a daemon that timed out
 * or crashed, or a box that is still starting up — and a computer-use executor that refuses is recognizable by identity,
 * since it is the one the host installs when there is no monitor to give.
 */
export const SLATE_BOX_NOT_READY_MESSAGE = "The computer is still starting up (downloading its image or booting). Try again in a moment."; export const SLATE_BOX_NOT_RESPONDING_MESSAGE = "The computer isn't responding — it may be wedged. Try again in a moment, or recover it from Settings → Updates → Update Slate's Computer."; export const SLATE_BOX_NO_MONITOR_AVAILABLE_MESSAGE = "Every desktop monitor on the shared computer is in use right now, so this agent can't get its own screen. Wait a moment and try again — one frees up when another agent or parallel computer-use subagent finishes.";
export class SlateBoxDaemonUnreachableError extends Error { constructor(readonly outcome: string, message: string, options?: ErrorOptions) { super(message, options); this.name = "SlateBoxDaemonUnreachableError"; } }
export class SlateBoxNoMonitorAvailableError extends Error { constructor(message = "No private desktop monitor is available on the shared box.") { super(message); this.name = "SlateBoxNoMonitorAvailableError"; } }
export function boxNotReadyMessageForError(error: unknown): string { if (error instanceof SlateBoxNoMonitorAvailableError) return SLATE_BOX_NO_MONITOR_AVAILABLE_MESSAGE; if (error instanceof SlateBoxDaemonUnreachableError && (error.outcome === "timeout" || error.outcome === "crash")) return SLATE_BOX_NOT_RESPONDING_MESSAGE; return SLATE_BOX_NOT_READY_MESSAGE; }
export const noMonitorComputerUseExecutor = { async execute(): Promise<never> { throw new SlateBoxNoMonitorAvailableError(); } }; export function isNoMonitorComputerUseExecutor(executor: unknown): boolean { return executor === noMonitorComputerUseExecutor; }
export const SLATE_BOX_PRIMARY_WINDOW_INDEX = 1; export const SLATE_BOX_FIRST_FORK_WINDOW_INDEX = 2; export function isPrimaryWindowIndex(windowIndex: number): boolean { return windowIndex <= SLATE_BOX_PRIMARY_WINDOW_INDEX; }
export class BoxEnvironmentSyncUnsupportedError extends Error { constructor() { super("This box does not support environment sync."); this.name = "BoxEnvironmentSyncUnsupportedError"; } } export class BoxMcpUnsupportedError extends Error { constructor() { super("This box does not support running MCP servers."); this.name = "BoxMcpUnsupportedError"; } }
