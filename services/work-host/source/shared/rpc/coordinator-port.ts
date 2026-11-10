/**
 * The port the coordinator answers on.
 *
 * A call names its method and its argument, and what comes back is either a result or a failure with the code the
 * caller can act on — cancelled, unknown method, or the coordinator's own error.
 */

export const COORDINATOR_PROTOCOL_VERSION = 1;
export const COORDINATOR_UNKNOWN_METHOD = "unknown-method";
export const COORDINATOR_CANCELLED = "cancelled";

export type CoordinatorFailure = { code: string; message: string; transportKind?: string };
export type CoordinatorReplyOutcome = { status: "ok"; value: unknown } | { status: "failed"; failure: CoordinatorFailure };
export type CoordinatorFrame =
  | { kind: "lifecycle"; phase: "hello" | "ready"; protocolVersion: number }
  | { kind: "lifecycle"; phase: "shutdown"; reason: "requested" | "protocol-error"; detail: string | null }
  | { kind: "request"; requestId: string; method: string; args: unknown }
  | { kind: "cancel"; requestId: string }
  | { kind: "reply"; requestId: string; outcome: CoordinatorReplyOutcome }
  | { kind: "event"; family: string; payload: unknown };

export type CoordinatorFrameParseResult =
  | { accepted: true; frame: CoordinatorFrame }
  | { accepted: false; rejection: { code: "malformed-frame"; detail: string } };

/** What one field of a frame can be, and the sentence a caller is given when it is not. */
type Verdict<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly detail: string };

const good = <T>(value: T): Verdict<T> => ({ ok: true, value });
const bad = <T>(detail: string): Verdict<T> => ({ ok: false, detail });

function text(value: unknown, field: string): Verdict<string> {
  return typeof value === "string" && value.length > 0 ? good(value) : bad(`${field} must be a non-empty string`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** A frame is read by what it says it is; anything else is a malformed frame with a sentence about it. */
function reject(detail: string): CoordinatorFrameParseResult {
  return { accepted: false, rejection: { code: "malformed-frame", detail } };
}

function accept(frame: CoordinatorFrame): CoordinatorFrameParseResult {
  return { accepted: true, frame };
}

// ── the reply a call comes back with ────────────────────────────────────────────────────────────────────────────

function readFailure(value: unknown): Verdict<CoordinatorFailure> {
  if (!isRecord(value)) return bad("reply.outcome is not a valid outcome");
  const code = text(value.code, "failure.code");
  if (!code.ok) return bad("reply.outcome is not a valid outcome");
  if (typeof value.message !== "string") return bad("reply.outcome is not a valid outcome");
  const transportKind = value.transportKind;
  const failure: CoordinatorFailure = { code: code.value, message: value.message };
  if (typeof transportKind === "string" && transportKind.length > 0) failure.transportKind = transportKind;
  return good(failure);
}

function readOutcome(value: unknown): Verdict<CoordinatorReplyOutcome> {
  if (!isRecord(value)) return bad("reply.outcome is not a valid outcome");
  if (value.status === "ok") {
    return "value" in value ? good({ status: "ok", value: value.value }) : bad("reply.outcome is not a valid outcome");
  }
  if (value.status !== "failed") return bad("reply.outcome is not a valid outcome");
  const failure = readFailure(value.failure);
  return failure.ok ? good({ status: "failed", failure: failure.value }) : bad("reply.outcome is not a valid outcome");
}

// ── lifecycle: the handshake that opens a connection and the shutdown that closes it ───────────────────────────

const LIFECYCLE_PHASE_REQUIRED = "lifecycle.phase must be hello, ready, or shutdown";

/** A table of readers, keyed by what a frame calls itself. A Map, so that a name from the object prototype is not a reader. */
type Readers = ReadonlyMap<string, (value: Record<string, unknown>) => Verdict<CoordinatorFrame>>;

/** The phases a peer may announce before any call: what version it speaks, or why it is going away. */
const LIFECYCLE_PHASES: Readers = new Map<string, (value: Record<string, unknown>) => Verdict<CoordinatorFrame>>(Object.entries({
  hello: (value) => readReadyPhase("hello", value),
  ready: (value) => readReadyPhase("ready", value),
  shutdown: (value) => {
    const reason = value.reason;
    if (reason !== "requested" && reason !== "protocol-error") return bad("lifecycle.shutdown.reason must be requested or protocol-error");
    if (reason === "protocol-error") {
      if (typeof value.detail !== "string" || value.detail.length === 0) return bad("lifecycle.shutdown.detail must name the breach for a protocol-error shutdown");
      return good({ kind: "lifecycle", phase: "shutdown", reason, detail: value.detail });
    }
    if (value.detail !== null) return bad("lifecycle.shutdown.detail must be null for a requested shutdown");
    return good({ kind: "lifecycle", phase: "shutdown", reason, detail: null });
  },
}));

/** Reads a phase a peer may announce, refusing the ones this port does not know. */
function readPhase(value: Record<string, unknown>): Verdict<CoordinatorFrame> {
  const phase = typeof value.phase === "string" ? LIFECYCLE_PHASES.get(value.phase) : undefined;
  return phase === undefined ? bad(LIFECYCLE_PHASE_REQUIRED) : phase(value);
}

function readReadyPhase(phase: "hello" | "ready", value: Record<string, unknown>): Verdict<CoordinatorFrame> {
  if (typeof value.protocolVersion !== "number") return bad(`lifecycle.${phase}.protocolVersion must be a number`);
  return good({ kind: "lifecycle", phase, protocolVersion: value.protocolVersion });
}

// ── the frames a peer may send ──────────────────────────────────────────────────────────────────────────────────

/** Reads the request id every call frame carries, or the sentence about what it should have been. */
function readRequestId(value: Record<string, unknown>, kind: string): Verdict<string> {
  const requestId = value.requestId;
  return typeof requestId === "string" && requestId.length > 0 ? good(requestId) : bad(`${kind}.requestId must be a non-empty string`);
}

const KINDS: Readers = new Map<string, (value: Record<string, unknown>) => Verdict<CoordinatorFrame>>(Object.entries({
  lifecycle: readPhase,
  request: (value) => {
    const requestId = readRequestId(value, "request");
    if (!requestId.ok) return requestId;
    const method = text(value.method, "request.method");
    if (!method.ok) return method;
    if (!("args" in value)) return bad("request.args is missing");
    return good({ kind: "request", requestId: requestId.value, method: method.value, args: value.args });
  },
  cancel: (value) => {
    const requestId = readRequestId(value, "cancel");
    return requestId.ok ? good({ kind: "cancel", requestId: requestId.value }) : requestId;
  },
  reply: (value) => {
    const requestId = readRequestId(value, "reply");
    if (!requestId.ok) return requestId;
    const outcome = readOutcome(value.outcome);
    return outcome.ok ? good({ kind: "reply", requestId: requestId.value, outcome: outcome.value }) : outcome;
  },
  event: (value) => {
    const family = text(value.family, "event.family");
    if (!family.ok) return family;
    if (!("payload" in value)) return bad("event.payload is missing");
    return good({ kind: "event", family: family.value, payload: value.payload });
  },
}));

const KINDS_REQUIRED = "frame.kind must be lifecycle, request, cancel, reply, or event";

/** A frame, or the reason it is not one. Nothing is half-read: a frame that is refused is refused whole. */
export function parseCoordinatorFrame(value: unknown): CoordinatorFrameParseResult {
  if (!isRecord(value)) return reject("frame must be an object");
  const kind = typeof value.kind === "string" ? KINDS.get(value.kind) : undefined;
  if (kind === undefined) return reject(KINDS_REQUIRED);
  const verdict = kind(value);
  return verdict.ok ? accept(verdict.value) : reject(verdict.detail);
}

// ── what the coordinator is told before anything else ──────────────────────────────────────────────────────────

export interface CoordinatorBootstrap {
  processConfig: { appVersion: string; isPackaged: boolean; dataDir: string };
}

export type CoordinatorBootstrapParseResult =
  | { accepted: true; bootstrap: CoordinatorBootstrap }
  | { accepted: false; rejection: { code: "malformed-frame"; detail: string } };

/** The bootstrap a coordinator is started with: where it is, whether it is packaged, and where its data lives. */
export function parseCoordinatorBootstrap(value: unknown): CoordinatorBootstrapParseResult {
  const refuse = (detail: string): CoordinatorBootstrapParseResult => ({ accepted: false, rejection: { code: "malformed-frame", detail } });
  if (!isRecord(value) || !isRecord(value.processConfig)) return refuse("bootstrap.processConfig must be an object");
  const { appVersion, isPackaged, dataDir } = value.processConfig;
  if (typeof appVersion !== "string" || appVersion.length === 0) return refuse("bootstrap.processConfig.appVersion must be a non-empty string");
  if (typeof isPackaged !== "boolean") return refuse("bootstrap.processConfig.isPackaged must be a boolean");
  if (typeof dataDir !== "string" || dataDir.length === 0) return refuse("bootstrap.processConfig.dataDir must be a non-empty string");
  return { accepted: true, bootstrap: { processConfig: { appVersion, isPackaged, dataDir } } };
}

// ── the channels a frame travels on ────────────────────────────────────────────────────────────────────────────

export const COORDINATOR_TRANSPORT_STATE_FAMILY = "coordinator-transport-state";
export const COORDINATOR_CONTROL_CHANNEL = "coordinator-control";
export const COORDINATOR_MAIN_DATA_CHANNEL = "coordinator-main-data";

/** A message on one channel, as a caller hands it over: the channel, and whatever was framed for it. */
function envelopeOn<Channel extends string>(channel: Channel) {
  return (value: unknown): { channel: Channel; frame: unknown } | null => {
    if (!isRecord(value) || value.channel !== channel || !("frame" in value)) return null;
    return { channel, frame: value.frame };
  };
}

export const asCoordinatorControlEnvelope = envelopeOn(COORDINATOR_CONTROL_CHANNEL);
export const asCoordinatorMainDataEnvelope = envelopeOn(COORDINATOR_MAIN_DATA_CHANNEL);
