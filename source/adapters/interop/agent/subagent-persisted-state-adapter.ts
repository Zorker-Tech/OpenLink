import { isMessage, type FieldInfo, type Message } from "@bufbuild/protobuf"
import {
  CloudSubagentReference,
  SubagentExecutionEnvironment,
  SubagentPersistedState,
} from "../proto/generated/agent/v1/agent_pb.ts"
import type {
  SlateSubagentCloudAgent,
  SlateSubagentPersistedState,
  SlateSubagentStateCompatibility,
} from "../../../packages/agent/subagent-persisted-state.ts"
import type {
  SlateCheckpointUnknownField,
  SlateCheckpointUnknownFieldPathStep,
} from "../../../packages/agent/conversation-checkpoint-state.ts"
import { fromHex, toHex } from "../../../packages/agent-kv/serde.ts"
import {
  createSlateSubagentPersistedState,
  type SlateSubagentConversationSnapshot,
} from "../../../packages/agent/subagent-persisted-state.ts"
import { slateSubagentTypeFromInterop, subagentTypeToInterop } from "./subagent-type-adapter.ts"
import {
  fromInteropTaskConversationState,
  toInteropTaskConversationState,
} from "./task-conversation-state-adapter.ts"
import {
  targetMachineFromProtoInterop,
  targetMachineToProtoInterop,
} from "./task-runtime-protocol-adapter.ts"

function protoFieldValue(message: Message, field: FieldInfo): unknown {
  const record = message as unknown as Record<string, unknown>
  if (field.oneof == null) return record[field.localName]
  const selection = record[field.oneof.localName]
  if (selection == null || typeof selection !== "object") return undefined
  const selected = selection as { readonly case?: unknown; readonly value?: unknown }
  return selected.case === field.localName ? selected.value : undefined
}

function collectUnknownFields(root: Message): SlateCheckpointUnknownField[] {
  const fields: SlateCheckpointUnknownField[] = []
  function visit(message: Message, path: readonly SlateCheckpointUnknownFieldPathStep[]): void {
    for (const field of message.getType().runtime.bin.listUnknownFields(message)) {
      fields.push({ path, number: field.no, wireType: field.wireType, dataHex: toHex(field.data) })
    }
    for (const field of message.getType().fields.list()) {
      const value = protoFieldValue(message, field)
      if (value == null) continue
      if (field.kind === "message") {
        if (field.repeated && Array.isArray(value)) {
          value.forEach((child, index) => {
            if (isMessage(child)) visit(child, [...path, { field: field.localName }, { index }])
          })
        } else if (!field.repeated && isMessage(value)) {
          visit(value, [...path, { field: field.localName }])
        }
      } else if (field.kind === "map" && field.V.kind === "message" && typeof value === "object") {
        const entries = value instanceof Map ? [...value.entries()] : Object.entries(value)
        for (const [key, child] of entries) {
          if (typeof key === "string" && isMessage(child)) visit(child, [...path, { field: field.localName }, { key }])
        }
      }
    }
  }
  visit(root, [])
  return fields
}

function messageAtPath(root: Message, path: readonly SlateCheckpointUnknownFieldPathStep[]): Message {
  let current: unknown = root
  for (const step of path) {
    if ("field" in step) {
      if (!isMessage(current)) throw new TypeError("Subagent compatibility-field parent is invalid")
      const field = current.getType().fields.list().find(candidate => candidate.localName === step.field)
      if (field === undefined) throw new TypeError("Subagent compatibility-field path is unsupported")
      current = protoFieldValue(current, field)
    } else if ("index" in step) {
      current = Array.isArray(current) ? current[step.index] : undefined
    } else if (current instanceof Map) {
      current = current.get(step.key)
    } else {
      current = current !== null && typeof current === "object"
        ? (current as Record<string, unknown>)[step.key]
        : undefined
    }
  }
  if (!isMessage(current)) throw new TypeError("Subagent compatibility-field target is missing")
  return current
}

function restoreUnknownFields(root: Message, fields: readonly SlateCheckpointUnknownField[] | undefined): void {
  for (const field of fields ?? []) {
    if (!Number.isSafeInteger(field.number) || field.number < 1 || field.number > 536_870_911 ||
        !Number.isInteger(field.wireType) || field.wireType < 0 || field.wireType > 5 ||
        !/^(?:[0-9a-f]{2})*$/.test(field.dataHex)) {
      throw new TypeError("Subagent compatibility-field metadata is invalid")
    }
    root.getType().runtime.bin.onUnknownField(
      messageAtPath(root, field.path),
      field.number,
      field.wireType as Parameters<typeof SubagentPersistedState.runtime.bin.onUnknownField>[2],
      fromHex(field.dataHex),
    )
  }
}

function environmentFromInterop(value: number): {
  readonly value: SlateSubagentPersistedState["executionEnvironment"]
  readonly legacyEnvironmentCode?: number
} {
  switch (value) {
    case SubagentExecutionEnvironment.UNSPECIFIED: return { value: "unspecified" }
    case SubagentExecutionEnvironment.LOCAL: return { value: "local" }
    case SubagentExecutionEnvironment.CLOUD: return { value: "cloud" }
    default: return { value: "unspecified", legacyEnvironmentCode: value }
  }
}

function environmentToInterop(value: SlateSubagentPersistedState["executionEnvironment"]): number {
  switch (value) {
    case "unspecified": return SubagentExecutionEnvironment.UNSPECIFIED
    case "local": return SubagentExecutionEnvironment.LOCAL
    case "cloud": return SubagentExecutionEnvironment.CLOUD
  }
}

function compatibilityWithUnknownFields(
  compatibility: SlateSubagentStateCompatibility | undefined,
  fields: readonly SlateCheckpointUnknownField[],
): SlateSubagentStateCompatibility | undefined {
  const legacyUnknownFields = fields.length === 0 ? compatibility?.legacyUnknownFields : fields
  const legacyEnvironmentCode = compatibility?.legacyEnvironmentCode
  if (legacyUnknownFields === undefined && legacyEnvironmentCode === undefined) return undefined
  return {
    ...(legacyEnvironmentCode === undefined ? {} : { legacyEnvironmentCode }),
    ...(legacyUnknownFields === undefined
      ? {}
      : { legacyUnknownFields: legacyUnknownFields.map(field => ({ ...field, path: field.path.map(step => ({ ...step })) })) }),
  }
}

/** Imports a historical generated state into Slate's own resume record. */
export function fromInteropSubagentPersistedState(
  value: SubagentPersistedState,
  privacyMode?: Parameters<typeof fromInteropTaskConversationState>[1],
  preservedUnknownFields?: readonly SlateCheckpointUnknownField[],
): SlateSubagentPersistedState {
  const environment = environmentFromInterop(value.environment)
  const unknownFields = preservedUnknownFields ?? collectUnknownFields(value)
  const cloudAgent: SlateSubagentCloudAgent | undefined = value.cloudSubagent === undefined
    ? undefined
    : {
        agentId: value.cloudSubagent.bcId,
        ...(value.cloudSubagent.transcriptPath === undefined ? {} : { transcriptUri: value.cloudSubagent.transcriptPath }),
      }
  const compatibility = compatibilityWithUnknownFields(
    environment.legacyEnvironmentCode === undefined
      ? undefined
      : { legacyEnvironmentCode: environment.legacyEnvironmentCode },
    unknownFields,
  )
  return createSlateSubagentPersistedState({
    createdAtMs: value.createdTimestampMs ?? BigInt(0),
    lastUsedAtMs: value.lastUsedTimestampMs ?? BigInt(0),
    executionEnvironment: environment.value,
    ...(value.conversationState === undefined
      ? {}
      : { conversationSnapshot: fromInteropTaskConversationState(value.conversationState, privacyMode) }),
    ...(value.subagentType === undefined ? {} : { subagentType: slateSubagentTypeFromInterop(value.subagentType) }),
    ...(value.modelId === undefined ? {} : { modelId: value.modelId }),
    ...(cloudAgent === undefined ? {} : { cloudAgent }),
    ...(value.firstClassBcId === undefined ? {} : { firstClassAgentId: value.firstClassBcId }),
    ...(value.cloudRequestedEnvironmentBuildId === undefined
      ? {}
      : { requestedRuntimeBuildId: value.cloudRequestedEnvironmentBuildId }),
    ...(value.machine === undefined ? {} : { targetMachine: targetMachineFromProtoInterop(value.machine) }),
    ...(compatibility === undefined ? {} : { compatibility }),
  })
}

/** Projects a Slate resume record only at the current runner/checkpoint edge. */
export function toInteropSubagentPersistedState(
  value: SlateSubagentPersistedState,
): SubagentPersistedState {
  const environment = value.compatibility?.legacyEnvironmentCode ?? environmentToInterop(value.executionEnvironment)
  const interop = new SubagentPersistedState({
    createdTimestampMs: value.createdAtMs,
    lastUsedTimestampMs: value.lastUsedAtMs,
    environment,
    ...(value.conversationSnapshot === undefined
      ? {}
      : { conversationState: toInteropTaskConversationState(value.conversationSnapshot) }),
    ...(value.subagentType === undefined ? {} : { subagentType: subagentTypeToInterop(value.subagentType)! }),
    ...(value.modelId === undefined ? {} : { modelId: value.modelId }),
    ...(value.cloudAgent === undefined
      ? {}
      : { cloudSubagent: new CloudSubagentReference({
          bcId: value.cloudAgent.agentId,
          ...(value.cloudAgent.transcriptUri === undefined ? {} : { transcriptPath: value.cloudAgent.transcriptUri }),
        }) }),
    ...(value.firstClassAgentId === undefined ? {} : { firstClassBcId: value.firstClassAgentId }),
    ...(value.requestedRuntimeBuildId === undefined
      ? {}
      : { cloudRequestedEnvironmentBuildId: value.requestedRuntimeBuildId }),
    ...(value.targetMachine === undefined ? {} : { machine: targetMachineToProtoInterop(value.targetMachine) }),
  })
  restoreUnknownFields(interop, value.compatibility?.legacyUnknownFields)
  return interop
}
