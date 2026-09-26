/**
 * The gateway paths a command is run over, and what to say when the machine it should run on is not there.
 *
 * A command runs on the user's own machine, which has to be reachable: the message says so in the two cases that
 * matter — no machine at all, and a machine that is named but is not answering — and names the computer the user meant
 * when there is a label for it.
 */
export const GATEWAY_LOCAL_EXEC_REQUESTS_PATH = "/local-exec/requests";
export const GATEWAY_LOCAL_EXEC_RESPONSES_PATH = "/local-exec/responses";
export const SLATE_NO_LOCAL_MACHINE_MESSAGE =
  "Your local machine isn't connected right now (the Slate desktop app must be open and online to run commands on it). Try again once it's reachable.";

const COMPUTER_UNAVAILABLE_SUFFIX =
  "is unavailable — it looks disconnected. Reconnect it (or focus the computer you want commands to run on) and try again.";

export const SLATE_COMPUTER_UNAVAILABLE_MESSAGE = `Your computer ${COMPUTER_UNAVAILABLE_SUFFIX}`;

export function slateComputerUnavailableMessage(label?: string): string {
  if (label === undefined || label.length === 0) return SLATE_COMPUTER_UNAVAILABLE_MESSAGE;
  return `Your computer "${label}" ${COMPUTER_UNAVAILABLE_SUFFIX}`;
}

export const SLATE_LOCAL_EXEC_LIVENESS_WINDOW_MS = 30_000;
export const SLATE_LOCAL_EXEC_RESPONSE_TIMEOUT_MS = 10_000;
export const SLATE_LOCAL_EXEC_HEARTBEAT_INTERVAL_MS = 10_000;
export const SLATE_LOCAL_EXEC_CONTROL_POST_TIMEOUT_MS = 10_000;
export const SLATE_LOCAL_EXEC_DATA_POST_TIMEOUT_MS = 120_000;
export const DEFAULT_MAX_LOCAL_EXEC_FILE_BYTES = 100 * 1024 * 1024;

export function describeLocalExecBytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export function localExecFileTooLargeMessage(actualBytes: number, maxBytes: number): string {
  return `File is ${describeLocalExecBytes(actualBytes)}, which exceeds Grok Bot's ${describeLocalExecBytes(maxBytes)} limit for reading or transferring a single file over local-exec. Read a slice with offset/limit, or use a shell command (grep, head, tail) to extract just what you need.`;
}

export function localExecUploadFrameTooLargeMessage(maxBytes: number): string {
  return `The upload exceeds Grok Bot's ${describeLocalExecBytes(maxBytes)} limit for transferring a single file over local-exec and was refused before being read into memory. Transfer a smaller file, or split it into parts.`;
}

export function maxLocalExecUploadFrameBytes(maxFileBytes: number): number {
  return Math.ceil(maxFileBytes * 4 / 3) + 64 * 1024;
}
