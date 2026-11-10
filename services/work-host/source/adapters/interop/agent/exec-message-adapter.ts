/**
 * Putting a typed call into the one message shape the exec channel carries.
 *
 * The channel is a single protobuf message with a oneof: one side sends the arguments of whatever
 * operation is being asked for, the other sends the result of whatever operation is being answered,
 * and both are addressed by the call's id. These four builders are what turns a specific args or
 * result type into that envelope, and back — and the deserializers answer "not mine" for a message
 * carrying a different case, because one stream can interleave several operations.
 */

import { ExecClientMessage, ExecServerMessage, SpanContext } from "../proto/generated/agent/v1/exec_pb.ts"
import type { SerializableSpanContext } from "../../../packages/context/telemetry.ts"
import type {
  ExecutorDecodedValue,
  ExecutorWireRequestOptions,
} from "../../../packages/agent-exec/executor-resources.ts"
import { fromInteropHookContextMessages } from "./hook-context-adapter.ts"

export type InteropExecClientMessage = ExecClientMessage
export type InteropExecServerMessage = ExecServerMessage

/** Construct the one generated frame the RPC channel needs from Slate's operation and tracing inputs. */
export function buildExecServerMessage(
  serialized: Pick<ExecServerMessage, "id" | "message">,
  options: {
    readonly execId?: string | undefined
    readonly spanContext?: SerializableSpanContext | undefined
    readonly collectHookContext: boolean
  },
): ExecServerMessage {
  const span = options.spanContext === undefined
    ? undefined
    : new SpanContext({
      traceId: options.spanContext.traceId,
      spanId: options.spanContext.spanId,
      traceFlags: options.spanContext.traceFlags,
      ...(options.spanContext.traceState === undefined ? {} : { traceState: options.spanContext.traceState }),
    })
  return new ExecServerMessage({
    id: serialized.id,
    message: serialized.message,
    ...(options.execId === undefined ? {} : { execId: options.execId }),
    ...(span === undefined ? {} : { spanContext: span }),
    acceptHookAdditionalContexts: options.collectHookContext,
  })
}

export type Serializer<T, Message> = (id: number, value: T) => Message
export type Deserializer<T, Message> = (message: Message) => { id: number; args: T } | undefined
export type ExecutorRequestSerializer<T> = (
  id: number,
  value: T,
  options: ExecutorWireRequestOptions,
) => ExecServerMessage

type ExecServerMessageArm = Exclude<ExecServerMessage["message"], { case: undefined }>
type ExecServerMessageCase = ExecServerMessageArm["case"]
type ExecServerMessageValue<Case extends ExecServerMessageCase> = Extract<ExecServerMessageArm, { case: Case }>["value"]

type ExecClientMessageArm = Exclude<ExecClientMessage["message"], { case: undefined }>
type ExecClientMessageCase = ExecClientMessageArm["case"]
type ExecClientMessageValue<Case extends ExecClientMessageCase> = Extract<ExecClientMessageArm, { case: Case }>["value"]

/** The client's side of a call: arguments wrapped under their own case. */
export function createServerSerializer<Case extends ExecServerMessageCase>(
  argsKey: Case,
): (
  id: number,
  args: ExecServerMessageValue<Case>,
  options?: ExecutorWireRequestOptions,
) => ExecServerMessage {
  function serialize(
    id: number,
    args: ExecServerMessageValue<Case>,
    options: ExecutorWireRequestOptions = { collectHookContext: false },
  ): ExecServerMessage {
    return buildExecServerMessage(
      { id, message: { case: argsKey, value: args } as ExecServerMessageArm },
      options,
    )
  }
  return serialize
}

/** The client reading a result out of the host's answer. */
export function createClientDeserializer<Case extends ExecClientMessageCase>(
  resultKey: Case,
): (message: ExecClientMessage) => ExecutorDecodedValue<ExecClientMessageValue<Case>> {
  return (result) => {
    const hookContexts = Array.isArray(result.hookAdditionalContexts)
      ? fromInteropHookContextMessages(result.hookAdditionalContexts)
      : []
    const decoded = {
      value: result.message.case === resultKey
        ? result.message.value as ExecClientMessageValue<Case>
        : undefined,
      ...(hookContexts.length === 0 ? {} : { hookContexts }),
    }
    return decoded
  }
}

/** The host's side of a call: the result wrapped under its own case. */
export function createClientSerializer<Case extends ExecClientMessageCase>(
  resultKey: Case,
): Serializer<ExecClientMessageValue<Case>, ExecClientMessage> {
  function serialize(id: number, result: ExecClientMessageValue<Case>): ExecClientMessage {
    const message = { case: resultKey, value: result } as ExecClientMessageArm
    return new ExecClientMessage({ id, message })
  }
  return serialize
}

/** The host reading the arguments out of the client's request, keeping the call's id. */
export function createServerDeserializer<Case extends ExecServerMessageCase>(
  argsKey: Case,
): Deserializer<ExecServerMessageValue<Case>, ExecServerMessage> {
  function deserialize(result: ExecServerMessage): { id: number; args: ExecServerMessageValue<Case> } | undefined {
    if (result.message.case !== argsKey) return undefined
    return { id: result.id, args: result.message.value as ExecServerMessageValue<Case> }
  }
  return deserialize
}
