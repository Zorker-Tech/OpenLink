import {
  AgentMode,
  CustomModeExitIntent,
  CustomModeIntent,
  CustomModeSource,
  SubmittedCustomMode,
  SubmittedExitedCustomMode,
  SubscriptionEventDisplay,
  SubscriptionSource,
  TriggeringUserInfo,
  UserMessage_SimulatedMessageMetadata,
} from "../proto/generated/agent/v1/agent_pb.ts"
import { fromInteropAgentMode, toInteropAgentMode } from "./mode-processing-adapter.ts"
import { RedactedString } from "../../../packages/redaction/redacted-values.ts"
import type { SlateMode } from "../../../packages/agent/mode-processing.ts"
import type {
  SlateCustomModeIntent,
  SlateCustomModeNextMode,
  SlateCustomModeSource,
  SlateExitedCustomMode,
  SlateSimulationDetails,
  SlateSubmittedCustomMode,
  SlateSubscriptionEventDisplay,
  SlateSubscriptionSource,
  SlateTriggeringActor,
  SlateUserMessageText,
} from "../../../packages/agent/user-message-metadata-state.ts"

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function requiredText(value: unknown, field: string): SlateUserMessageText {
  if (typeof value === "string" || value instanceof RedactedString) return value
  throw new TypeError(`User-message metadata field ${field} must be text`)
}

function optionalText(value: unknown, field: string): SlateUserMessageText | undefined {
  return value === undefined ? undefined : requiredText(value, field)
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "string") throw new TypeError(`User-message metadata field ${field} must be a string`)
  return value
}

function unknownEnumCode(value: string): number | undefined {
  const match = /^unknown-(-?\d+)$/.exec(value)
  if (match === null) return undefined
  const code = Number(match[1])
  return Number.isSafeInteger(code) && code >= -2_147_483_648 && code <= 2_147_483_647
    ? code
    : undefined
}

function sourceFromCode<T extends string>(value: unknown, values: ReadonlyMap<number, T>): T | `unknown-${number}` {
  if (typeof value === "string") {
    if ([...values.values()].includes(value as T)) return value as T
    if (unknownEnumCode(value) !== undefined) return value as `unknown-${number}`
    throw new TypeError(`User-message enum value is not recognized: ${value}`)
  }
  if (value === undefined) {
    const unspecified = values.get(0)
    if (unspecified !== undefined) return unspecified
    throw new TypeError("User-message enum value is missing")
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < -2_147_483_648 || value > 2_147_483_647) {
    throw new TypeError("User-message enum value must be a signed 32-bit integer")
  }
  return values.get(value) ?? `unknown-${value}`
}

function sourceToCode<T extends string>(value: T | `unknown-${number}`, values: ReadonlyMap<T, number>): number {
  const code = (values as ReadonlyMap<string, number>).get(value)
  if (code !== undefined) return code
  const unknown = unknownEnumCode(value)
  if (unknown !== undefined) return unknown
  throw new TypeError(`Slate user-message enum value is not recognized: ${value}`)
}

const customModeSourceFromCode = new Map<number, SlateCustomModeSource>([
  [CustomModeSource.UNSPECIFIED, "unspecified"],
  [CustomModeSource.AGENT_SKILL, "agent-skill"],
  [CustomModeSource.PLUGIN_SKILL, "plugin-skill"],
  [CustomModeSource.REPO_SKILL, "repository-skill"],
  [CustomModeSource.MANAGED_SKILL, "managed-skill"],
])
const customModeSourceToCode = new Map<SlateCustomModeSource, number>(
  [...customModeSourceFromCode].map(([code, source]) => [source, code]),
)
const subscriptionSourceFromCode = new Map<number, SlateSubscriptionSource>([
  [SubscriptionSource.UNSPECIFIED, "unspecified"],
  [SubscriptionSource.SLACK, "slack"],
  [SubscriptionSource.GITHUB, "github"],
  [SubscriptionSource.LINEAR, "linear"],
  [SubscriptionSource.ORIGIN, "origin"],
])
const subscriptionSourceToCode = new Map<SlateSubscriptionSource, number>(
  [...subscriptionSourceFromCode].map(([code, source]) => [source, code]),
)

export function triggeringActorFromInterop(value: unknown): SlateTriggeringActor | undefined {
  if (value === undefined) return undefined
  const record = recordOf(value)
  if (record === undefined) throw new TypeError("User-message triggering actor must be an object")
  const userId = record.userId
  if (userId !== undefined && (typeof userId !== "number" || !Number.isInteger(userId) || userId < -2_147_483_648 || userId > 2_147_483_647)) {
    throw new TypeError("User-message triggering actor userId must be a signed 32-bit integer")
  }
  const authId = optionalString(record.authId, "authId")
  return {
    ...(authId === undefined ? {} : { authId }),
    ...(userId === undefined ? {} : { userId: userId as number }),
  }
}

export function triggeringActorToInterop(value: SlateTriggeringActor | undefined): TriggeringUserInfo | undefined {
  return value === undefined ? undefined : new TriggeringUserInfo({
    ...(value.authId === undefined ? {} : { authId: value.authId }),
    ...(value.userId === undefined ? {} : { userId: value.userId }),
  })
}

function subscriptionEventDisplayFromInterop(value: unknown): SlateSubscriptionEventDisplay | undefined {
  if (value === undefined) return undefined
  const record = recordOf(value)
  if (record === undefined) throw new TypeError("User-message subscription display must be an object")
  return {
    ...(record.displayLabel === undefined ? {} : { label: optionalText(record.displayLabel, "displayLabel") as SlateUserMessageText }),
    ...(record.resourceUrl === undefined ? {} : { resourceUrl: optionalText(record.resourceUrl, "resourceUrl") as SlateUserMessageText }),
    ...(record.subscriptionId === undefined ? {} : { subscriptionId: optionalString(record.subscriptionId, "subscriptionId") as string }),
  }
}

function subscriptionEventDisplayToInterop(value: SlateSubscriptionEventDisplay | undefined): SubscriptionEventDisplay | undefined {
  return value === undefined ? undefined : new SubscriptionEventDisplay({
    ...(value.label === undefined ? {} : { displayLabel: value.label as never }),
    ...(value.resourceUrl === undefined ? {} : { resourceUrl: value.resourceUrl as never }),
    ...(value.subscriptionId === undefined ? {} : { subscriptionId: value.subscriptionId }),
  })
}

export function simulationDetailsFromInterop(value: unknown): SlateSimulationDetails | undefined {
  if (value === undefined) return undefined
  const record = recordOf(value)
  if (record === undefined) throw new TypeError("User-message simulation details must be an object")
  const source = record.subscriptionSource
  return {
    ...(record.title === undefined ? {} : { title: optionalText(record.title, "title") as SlateUserMessageText }),
    ...(record.taskId === undefined ? {} : { taskId: optionalString(record.taskId, "taskId") as string }),
    ...(record.fsdFindingAction === undefined && record.findingAction === undefined ? {} : {
      findingAction: optionalString(record.findingAction ?? record.fsdFindingAction, "findingAction") as string,
    }),
    ...(record.url === undefined ? {} : { url: optionalText(record.url, "url") as SlateUserMessageText }),
    ...(source === undefined ? {} : { subscriptionSource: sourceFromCode(source, subscriptionSourceFromCode) as SlateSubscriptionSource }),
    ...(record.subscriptionEventDisplay === undefined && record.subscriptionEvent === undefined ? {} : {
      subscriptionEvent: subscriptionEventDisplayFromInterop(record.subscriptionEvent ?? record.subscriptionEventDisplay) as SlateSubscriptionEventDisplay,
    }),
  }
}

export function simulationDetailsToInterop(value: SlateSimulationDetails | undefined): UserMessage_SimulatedMessageMetadata | undefined {
  if (value === undefined) return undefined
  const source = value.subscriptionSource
  const subscriptionEventDisplay = subscriptionEventDisplayToInterop(value.subscriptionEvent)
  return new UserMessage_SimulatedMessageMetadata({
    ...(value.title === undefined ? {} : { title: value.title as never }),
    ...(value.taskId === undefined ? {} : { taskId: value.taskId }),
    ...(value.findingAction === undefined ? {} : { fsdFindingAction: value.findingAction }),
    ...(value.url === undefined ? {} : { url: value.url as never }),
    ...(source === undefined ? {} : { subscriptionSource: sourceToCode(source, subscriptionSourceToCode) as SubscriptionSource }),
    ...(subscriptionEventDisplay === undefined ? {} : { subscriptionEventDisplay }),
  })
}

function submittedCustomModeFromInterop(value: unknown): SlateSubmittedCustomMode {
  const record = recordOf(value)
  if (record === undefined) throw new TypeError("User-message submitted mode must be an object")
  return {
    id: requiredText(record.id, "customMode.id"),
    label: optionalString(record.label, "customMode.label") ?? "",
    source: sourceFromCode(record.source, customModeSourceFromCode),
    ...(record.sourcePath === undefined ? {} : { sourcePath: optionalText(record.sourcePath, "sourcePath") as SlateUserMessageText }),
    ...(record.sourceHash === undefined ? {} : { sourceHash: optionalString(record.sourceHash, "sourceHash") as string }),
    ...(record.managedSkillId === undefined ? {} : { managedSkillId: optionalString(record.managedSkillId, "managedSkillId") as string }),
    ...(record.pluginId === undefined ? {} : { pluginId: optionalString(record.pluginId, "pluginId") as string }),
    ...(record.pluginSnapshotToken === undefined ? {} : { pluginSnapshotToken: optionalText(record.pluginSnapshotToken, "pluginSnapshotToken") as SlateUserMessageText }),
  }
}

function submittedCustomModeToInterop(value: SlateSubmittedCustomMode): SubmittedCustomMode {
  return new SubmittedCustomMode({
    id: value.id as never,
    label: value.label,
    source: sourceToCode(value.source, customModeSourceToCode) as CustomModeSource,
    ...(value.sourcePath === undefined ? {} : { sourcePath: value.sourcePath as never }),
    ...(value.sourceHash === undefined ? {} : { sourceHash: value.sourceHash }),
    ...(value.managedSkillId === undefined ? {} : { managedSkillId: value.managedSkillId }),
    ...(value.pluginId === undefined ? {} : { pluginId: value.pluginId }),
    ...(value.pluginSnapshotToken === undefined ? {} : { pluginSnapshotToken: value.pluginSnapshotToken as never }),
  })
}

function exitedCustomModeFromInterop(value: unknown): SlateExitedCustomMode {
  const record = recordOf(value)
  if (record === undefined) throw new TypeError("User-message exited mode must be an object")
  return {
    id: requiredText(record.id, "exitedMode.id"),
    label: optionalString(record.label, "exitedMode.label") ?? "",
  }
}

function exitedCustomModeToInterop(value: SlateExitedCustomMode): SubmittedExitedCustomMode {
  return new SubmittedExitedCustomMode({ id: value.id as never, label: value.label })
}

function nextModeFromInterop(value: unknown): SlateCustomModeNextMode {
  if (typeof value !== "number" || !Number.isInteger(value)) return "unspecified"
  const slateMode = fromInteropAgentMode(value as AgentMode)
  if (slateMode === undefined) return "unspecified"
  return toInteropAgentMode(slateMode) === value
    ? slateMode
    : { kind: "unrecognized", code: value }
}

function nextModeToInterop(value: SlateCustomModeNextMode): AgentMode {
  return typeof value === "string" ? toInteropAgentMode(value) : value.code as AgentMode
}

export function customModeIntentFromInterop(value: unknown): SlateCustomModeIntent | undefined {
  if (value === undefined) return undefined
  const record = recordOf(value)
  if (record === undefined) throw new TypeError("User-message custom mode intent must be an object")
  const intent = record.intent
  const oneof = recordOf(intent)
  if (oneof === undefined || oneof.case === undefined) return { kind: "unspecified" }
  switch (oneof.case) {
    case "enter": return { kind: "enter", mode: submittedCustomModeFromInterop(oneof.value) }
    case "exit": {
      const exit = recordOf(oneof.value)
      if (exit === undefined) throw new TypeError("User-message custom mode exit must be an object")
      return {
        kind: "exit",
        nextMode: nextModeFromInterop(exit.nextMode),
        ...(exit.exitedMode === undefined ? {} : { exitedMode: exitedCustomModeFromInterop(exit.exitedMode) }),
      }
    }
    default:
      return { kind: "unspecified" }
  }
}

export function customModeIntentToInterop(value: SlateCustomModeIntent | undefined): CustomModeIntent | undefined {
  if (value === undefined) return undefined
  switch (value.kind) {
    case "unspecified":
      return new CustomModeIntent()
    case "enter":
      return new CustomModeIntent({ intent: { case: "enter", value: submittedCustomModeToInterop(value.mode) } })
    case "exit":
      return new CustomModeIntent({
        intent: {
          case: "exit",
          value: new CustomModeExitIntent({
            nextMode: nextModeToInterop(value.nextMode),
            ...(value.exitedMode === undefined ? {} : { exitedMode: exitedCustomModeToInterop(value.exitedMode) }),
          }),
        },
      })
  }
}
