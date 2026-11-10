/** Routes, timing bounds and user-facing limits for commands that run on a local machine. */
export const GATEWAY_LOCAL_EXEC_REQUESTS_PATH = "/local-exec/requests";
export const GATEWAY_LOCAL_EXEC_RESPONSES_PATH = "/local-exec/responses";

export const SLATE_NO_LOCAL_MACHINE_MESSAGE =
  "No local machine is connected. Keep the Slate desktop app open on the machine that should run commands, then retry when it comes online.";

const COMPUTER_UNAVAILABLE_GUIDANCE =
  "is unavailable right now. Reconnect it or select the computer where the command should run, then try again.";

function computerUnavailableMessage(label?: string): string {
  const subject = label === undefined || label.length === 0 ? "Your computer" : `Your computer "${label}"`;
  return `${subject} ${COMPUTER_UNAVAILABLE_GUIDANCE}`;
}

export const SLATE_COMPUTER_UNAVAILABLE_MESSAGE = computerUnavailableMessage();

export function slateComputerUnavailableMessage(label?: string): string {
  return computerUnavailableMessage(label);
}

export const SLATE_LOCAL_EXEC_LIVENESS_WINDOW_MS = 30_000;
export const SLATE_LOCAL_EXEC_RESPONSE_TIMEOUT_MS = 10_000;
export const SLATE_LOCAL_EXEC_HEARTBEAT_INTERVAL_MS = 10_000;
export const SLATE_LOCAL_EXEC_CONTROL_POST_TIMEOUT_MS = 10_000;
export const SLATE_LOCAL_EXEC_DATA_POST_TIMEOUT_MS = 120_000;
export const DEFAULT_MAX_LOCAL_EXEC_FILE_BYTES = 100 * 1024 * 1024;

const BYTES_PER_MEBIBYTE = 1024 * 1024;
const BASE64_FRAME_EXTRA_BYTES = 64 * 1024;

export function describeLocalExecBytes(bytes: number): string {
  return `${(bytes / BYTES_PER_MEBIBYTE).toFixed(1)} MiB`;
}

export function localExecFileTooLargeMessage(actualBytes: number, maxBytes: number): string {
  const actual = describeLocalExecBytes(actualBytes);
  const limit = describeLocalExecBytes(maxBytes);
  return [
    `This file is ${actual} and exceeds the ${limit} per-file limit for local-exec reads and transfers.`,
    "Use an offset/limit range or a shell command (grep, head, tail) to select only the needed content.",
  ].join(" ");
}

export function localExecUploadFrameTooLargeMessage(maxBytes: number): string {
  const limit = describeLocalExecBytes(maxBytes);
  return [
    `This upload exceeds the ${limit} single-file local-exec limit.`,
    "It was rejected before its contents were read into memory.",
    "Send a smaller file or split it into parts.",
  ].join(" ");
}

export function maxLocalExecUploadFrameBytes(maxFileBytes: number): number {
  const base64Size = Math.ceil(maxFileBytes * 4 / 3);
  return base64Size + BASE64_FRAME_EXTRA_BYTES;
}
