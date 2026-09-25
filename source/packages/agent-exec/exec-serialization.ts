/**
 * Putting a typed call into the one message shape the exec channel carries.
 *
 * The channel is a single protobuf message with a oneof: one side sends the arguments of whatever
 * operation is being asked for, the other sends the result of whatever operation is being answered,
 * and both are addressed by the call's id. These four builders are what turns a specific args or
 * result type into that envelope, and back — and the deserializers answer "not mine" for a message
 * carrying a different case, because one stream can interleave several operations.
 */

import { ExecClientMessage, ExecServerMessage } from "../proto/generated/agent/v1/exec_pb.ts"

export type Serializer<T, Message> = (id: number, value: T) => Message
export type Deserializer<T, Message> = (message: Message) => { id: number; args: T } | undefined

type ExecServerMessageArm = Exclude<ExecServerMessage["message"], { case: undefined }>
type ExecServerMessageCase = ExecServerMessageArm["case"]
type ExecServerMessageValue<Case extends ExecServerMessageCase> = Extract<ExecServerMessageArm, { case: Case }>["value"]

type ExecClientMessageArm = Exclude<ExecClientMessage["message"], { case: undefined }>
type ExecClientMessageCase = ExecClientMessageArm["case"]
type ExecClientMessageValue<Case extends ExecClientMessageCase> = Extract<ExecClientMessageArm, { case: Case }>["value"]

/** The client's side of a call: arguments wrapped under their own case. */
export function createServerSerializer<Case extends ExecServerMessageCase>(
  argsKey: Case,
): Serializer<ExecServerMessageValue<Case>, ExecServerMessage> {
  function serialize(id: number, args: ExecServerMessageValue<Case>): ExecServerMessage {
    return new ExecServerMessage({
      id,
      message: { case: argsKey, value: args } as ExecServerMessageArm,
    })
  }
  return serialize
}

/** The client reading a result out of the host's answer. */
export function createClientDeserializer<Case extends ExecClientMessageCase>(
  resultKey: Case,
): (message: ExecClientMessage) => ExecClientMessageValue<Case> | undefined {
  return (result) => {
    if (result.message.case !== resultKey) return undefined
    return result.message.value as ExecClientMessageValue<Case>
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
