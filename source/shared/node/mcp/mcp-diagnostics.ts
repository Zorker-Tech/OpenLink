/**
 * What an MCP call did while it ran.
 *
 * Each leg of a call is recorded with the error it ended in, and what happened before the diagnostics were pinned is
 * held and replayed rather than lost.
 */

/** One leg of an MCP call, and the class of the error that leg ended in. */
export interface McpDiagnostic {
  readonly leg: string;
  readonly errorClass: string;
}

/** How many failures are held while nobody is listening yet. */
const PENDING_LIMIT = 32;

export const MCP_ERROR_RESULT_CLASS = "mcp_error_result";

/** How many tool calls remember the class of the error they ended in. */
export const EXEC_ERROR_CLASS_CAP = 128;

/* @connectrpc/connect 1.6.1 Code, recovered from the immutable host bundle. */
const CONNECT_CODES: Readonly<Record<number, string>> = {
  1: "Canceled",
  2: "Unknown",
  3: "InvalidArgument",
  4: "DeadlineExceeded",
  5: "NotFound",
  6: "AlreadyExists",
  7: "PermissionDenied",
  8: "ResourceExhausted",
  9: "FailedPrecondition",
  10: "Aborted",
  11: "OutOfRange",
  12: "Unimplemented",
  13: "Internal",
  14: "Unavailable",
  15: "DataLoss",
  16: "Unauthenticated",
};

/** Where failures go once the host is listening; until then they wait, up to the limit. */
let reporter: ((failure: McpDiagnostic) => void) | null = null;
let pending: McpDiagnostic[] = [];

/** The class of the error each tool call ended in, oldest first so the oldest is the one forgotten. */
const execErrorClass = new Map<string, string>();

/** Hands every failure held so far to a listener, and drops them: what was waited for is not replayed twice. */
export function pinMcpDiagnosticsReporter(pin: ((failure: McpDiagnostic) => void) | null): void {
  reporter = pin;
  const backlog = pending;
  pending = [];
  if (pin === null) return;
  for (const failure of backlog) pin(failure);
}

/** The name of a connect error's code, when the error is one and the code is a number it knows. */
function connectCodeName(error: Error): string | undefined {
  const code = Reflect.get(error, "code");
  return typeof code === "number" ? CONNECT_CODES[code] : undefined;
}

/** Whether a failure says it came from connect with a code of its own. */
function isConnectError(error: Error): boolean {
  return error.name === "ConnectError" && "code" in error;
}

/** What a failure is called in a diagnostic: a connect code, the error's own name, or what was thrown. */
export function mcpErrorClassOf(error: unknown): string {
  if (!(error instanceof Error)) return typeof error;
  // A connect failure is named after its code even when the code is one this build does not know.
  if (isConnectError(error)) return `ConnectError.${String(connectCodeName(error))}`;
  return error.name.length > 0 ? error.name : "Error";
}

/** Records a failure for whoever is listening, or holds it while nobody is. */
function emit(failure: McpDiagnostic): void {
  if (reporter !== null) {
    reporter(failure);
    return;
  }
  if (pending.length >= PENDING_LIMIT) return;
  pending.push(failure);
}

export function reportMcpHostEdgeFailure(leg: string, error: unknown): void {
  emit({ leg, errorClass: mcpErrorClassOf(error) });
}

export function reportMcpHostEdgeDegraded(leg: string, errorClass: string): void {
  emit({ leg, errorClass });
}

/** Remembers the class of the error a tool call ended in, forgetting the oldest once the map is full. */
export function recordMcpExecErrorClass(toolCallId: string, error: unknown): void {
  if (toolCallId.length === 0) return;
  if (execErrorClass.size >= EXEC_ERROR_CLASS_CAP) {
    const oldest = execErrorClass.keys().next().value;
    if (oldest != null) execErrorClass.delete(oldest);
  }
  execErrorClass.set(toolCallId, mcpErrorClassOf(error));
}

/** The class of the error a tool call ended in, once: reading it forgets it. */
export function takeMcpExecErrorClass(toolCallId: string): string {
  const recorded = execErrorClass.get(toolCallId);
  if (recorded === undefined) return MCP_ERROR_RESULT_CLASS;
  execErrorClass.delete(toolCallId);
  return recorded;
}
