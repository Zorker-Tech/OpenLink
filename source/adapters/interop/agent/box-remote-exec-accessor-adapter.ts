/**
 * Reaching a box's files over the tunnel.
 *
 * Reads, writes and listings are carried as framed requests with their own deadlines, and what a caller gets back is a
 * typed pingOutcome — the bytes, the failure the box reported, or the fact that the box is not there.
 */
import { findSystemErrno } from "../../../shared/system-errno.ts";
import type { Context } from "../../../packages/context/context.ts";
import type { RemoteExecManager } from "../../../packages/agent-exec/executor-resources.ts";
import type {
  ExecClientMessage,
  ExecServerMessage
} from "../proto/generated/agent/v1/exec_pb.ts";

export interface BoxEndpoint {
  readonly host: string;
  readonly port: number;
  readonly authToken: string;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface BoxTransportHeader {
  set(name: string, value: string): void;
}

export interface BoxTransportRequest {
  readonly header: BoxTransportHeader;
}

export type BoxTransportNext<Reply = unknown> = (
  outgoing: BoxTransportRequest
) => Promise<Reply>;

export type BoxTransportInterceptor = <Reply>(
  step: BoxTransportNext<Reply>
) => BoxTransportNext<Reply>;

export interface BoxTransportOptions {
  readonly httpVersion: "1.1";
  readonly baseUrl: string;
  readonly useBinaryFormat: true;
  readonly interceptors: readonly BoxTransportInterceptor[];
}

export type BoxTransportFactory<Pipe> = (
  options: BoxTransportOptions
) => Pipe;

export interface BoxPingControlClient {
  ping(
    context: Context,
    outgoing: Readonly<Record<string, never>>,
    options: { readonly timeoutMs: number }
  ): Promise<unknown>;
}

export type BoxControlClientFactory<Pipe> = (
  pipe: Pipe
) => BoxPingControlClient;

export type BoxRemoteExecControlMessage =
  | {
      readonly case: "streamClose";
      readonly value: { readonly id: number };
    }
  | {
      readonly case: "throw";
      readonly value: {
        readonly id?: number;
        readonly error: string;
        readonly stackTrace?: string;
        readonly errorCode?: string;
      };
    }
  | {
      readonly case: "heartbeat";
      readonly value: { readonly id: number };
    }
  | { readonly case: undefined; readonly value?: undefined };

export interface BoxRemoteExecEnvelope {
  readonly element:
    | { readonly case: "execClientMessage"; readonly value: ExecClientMessage }
    | {
        readonly case: "execClientControlMessage";
        readonly value: {
          readonly message: BoxRemoteExecControlMessage;
        };
      }
    | { readonly case: undefined; readonly value?: undefined };
}

export interface BoxRemoteExecClient {
  exec(context: Context, args: ExecServerMessage): AsyncIterable<BoxRemoteExecEnvelope>;
}

export interface BoxRemoteResourceConstructionPorts<Pipe, Store> {
  readonly createTransport: BoxTransportFactory<Pipe>;
  createExecClient(pipe: Pipe): BoxRemoteExecClient;
  createResourceAccessor(execManager: BoxRemoteExecManager): Store;
}

export type BoxPingOutcome = {
  readonly outcome: "ok" | "timeout" | "refused" | "crash";
  readonly latencyMs: number;
  readonly causeSummary?: string;
};

/** The name a gRPC-style connect code is reported under; the platform's boxes speak these codes. */
const CONNECT_CODE_NAMES: Readonly<Record<number, string>> = Object.freeze({
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
  16: "Unauthenticated"
});

/** The connect code an failure carries, when it carries one at all. */
function errorCodeOf(failure: unknown): number | string | undefined {
  if (typeof failure !== "object" || failure === null || !("code" in failure)) return undefined;
  const code = failure.code;
  return typeof code === "number" || typeof code === "string" ? code : undefined;
}

/** The name an failure's connect code is reported under, or "unknown" when it has none. */
function errorCodeName(failure: unknown): string {
  const code = errorCodeOf(failure);
  if (typeof code === "number") return CONNECT_CODE_NAMES[code] ?? "unknown";
  if (typeof code === "string" && code.length > 0) return code;
  return "unknown";
}

/** The message a failure carries, or an empty text when the failure is not an Error. */
function failureMessage(failure: unknown): string {
  return failure instanceof Error ? failure.message : "";
}

/** Whether a failure is the box not answering in time. */
function isDeadlineFailure(failure: unknown, message: string): boolean {
  return errorCodeOf(failure) === 4 || /deadline/i.test(message);
}

/** Whether a failure is the box refusing the connection. */
function isRefusedFailure(errno: string | undefined, message: string): boolean {
  return errno === "ECONNREFUSED" || /ECONNREFUSED/i.test(message);
}

export function createBoxAuthorizationInterceptor(
  target: BoxEndpoint
): BoxTransportInterceptor {
  return step => async outgoing => {
    outgoing.header.set("Authorization", `Bearer ${target.authToken}`);
    for (const [name, value] of Object.entries(target.headers ?? {})) {
      outgoing.header.set(name, value);
    }
    return await step(outgoing);
  };
}

/** The pipe options a box is reached with: its host and port, the binary format, and its authorization. */
function boxTransportOptions(
  target: BoxEndpoint,
  authorization: BoxTransportInterceptor
): BoxTransportOptions {
  return {
    httpVersion: "1.1",
    baseUrl: `http://${target.host}:${target.port}`,
    useBinaryFormat: true,
    interceptors: [authorization]
  };
}

export function createBoxTransport<Pipe>(
  target: BoxEndpoint,
  createTransport: BoxTransportFactory<Pipe>
): Pipe {
  return createTransport(boxTransportOptions(target, createBoxAuthorizationInterceptor(target)));
}

export function classifyPingFailure(
  failure: unknown
): { outcome: "timeout" | "refused" | "crash"; causeSummary: string } {
  const errno = findSystemErrno(failure);
  const codeName = errorCodeName(failure);
  const causeSummary = errno == null ? codeName : `${codeName}/${errno}`;
  const message = failureMessage(failure);
  if (isDeadlineFailure(failure, message)) return { outcome: "timeout", causeSummary };
  if (isRefusedFailure(errno, message)) return { outcome: "refused", causeSummary };
  return { outcome: "crash", causeSummary };
}

/** Whether a ping answered at all. */
function pingSucceeded(pingOutcome: BoxPingOutcome): boolean {
  return pingOutcome.outcome === "ok";
}

export async function pingBoxTransportClassified<Pipe>(
  context: Context,
  pipe: Pipe,
  controlClientFactory: BoxControlClientFactory<Pipe>,
  deadlineMs = 1_500,
  clock: () => number = Date.now
): Promise<BoxPingOutcome> {
  const frame = controlClientFactory(pipe);
  const startedAtMs = clock();
  try {
    await frame.ping(context, {}, { timeoutMs: deadlineMs });
    return { outcome: "ok", latencyMs: clock() - startedAtMs };
  } catch (failure) {
    return { ...classifyPingFailure(failure), latencyMs: clock() - startedAtMs };
  }
}

export async function pingBoxClassified<Pipe>(
  context: Context,
  target: BoxEndpoint,
  ports: {
    readonly createTransport: BoxTransportFactory<Pipe>;
    readonly createControlClient: BoxControlClientFactory<Pipe>;
  },
  deadlineMs = 1_500
): Promise<BoxPingOutcome> {
  const pipe = createBoxTransport(target, ports.createTransport);
  return await pingBoxTransportClassified(
    context,
    pipe,
    ports.createControlClient,
    deadlineMs
  );
}

export async function pingBoxTransport<Pipe>(
  context: Context,
  pipe: Pipe,
  controlClientFactory: BoxControlClientFactory<Pipe>,
  deadlineMs = 1_500
): Promise<boolean> {
  const pingOutcome = await pingBoxTransportClassified(
    context,
    pipe,
    controlClientFactory,
    deadlineMs
  );
  return pingSucceeded(pingOutcome);
}

export async function pingBox<Pipe>(
  context: Context,
  target: BoxEndpoint,
  ports: {
    readonly createTransport: BoxTransportFactory<Pipe>;
    readonly createControlClient: BoxControlClientFactory<Pipe>;
  },
  deadlineMs = 1_500
): Promise<boolean> {
  return pingSucceeded(await pingBoxClassified(context, target, ports, deadlineMs));
}

/** The error a control frame reports, with the box's stack when it sent one. */
function thrownByControlFrame(frame: {
  readonly error: string;
  readonly stackTrace?: string;
}): Error {
  const raised = new Error(frame.error);
  if (frame.stackTrace != null && frame.stackTrace.length > 0) {
    raised.stack = frame.stackTrace;
  }
  return raised;
}

export class BoxRemoteExecManager implements RemoteExecManager {
  #requestId = 0;

  constructor(readonly client: BoxRemoteExecClient) {}

  async *createExecInstance(
    context: Context,
    encode: (id: number) => ExecServerMessage
  ): AsyncIterable<ExecClientMessage> {
    const outgoing = encode(this.#requestId++);
    for await (const envelope of this.client.exec(context, outgoing)) {
      const part = envelope.element;
      if (part.case === "execClientMessage") {
        yield part.value;
        continue;
      }
      if (part.case !== "execClientControlMessage") continue;
      const frame = part.value.message;
      if (frame.case !== "throw") continue;
      throw thrownByControlFrame(frame.value);
    }
  }
}

export function createBoxRemoteResourceAccessorFromTransport<
  Pipe,
  Store
>(
  pipe: Pipe,
  ports: Pick<
    BoxRemoteResourceConstructionPorts<Pipe, Store>,
    "createExecClient" | "createResourceAccessor"
  >
): Store {
  return ports.createResourceAccessor(
    new BoxRemoteExecManager(ports.createExecClient(pipe))
  );
}

export function createBoxRemoteResourceAccessor<Pipe, Store>(
  target: BoxEndpoint,
  ports: BoxRemoteResourceConstructionPorts<Pipe, Store>
): Store {
  return createBoxRemoteResourceAccessorFromTransport(
    createBoxTransport(target, ports.createTransport),
    ports
  );
}
