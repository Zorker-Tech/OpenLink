/** Slate's durable task operation, including the nested transcript returned by a completed task. */

import { isRedactedString, type RedactedString } from "../redaction/redacted-values.ts"
import type { SlateTaskBackgroundReason } from "./tools/task-result-state.ts"
import type { TaskTargetMachine } from "./tools/task-runtime-types.ts"
import type { SlateSubagentType } from "./subagent-type.ts"
import type { SlateConversationStep } from "./conversation-step-state.ts"

export type SlateTaskToolText = string | RedactedString

export type SlateTaskMode =
  | "unspecified"
  | "agent"
  | "plan"

export type SlateTaskExecutionEnvironment =
  | "unspecified"
  | "local"
  | "cloud"

type SlateTaskTextProjection<Value, Text extends string | RedactedString> =
  Value extends RedactedString ? RedactedString
    : Value extends string ? string extends Value ? Text : Value
      : Value extends Uint8Array ? Value
        : Value extends readonly (infer Entry)[] ? readonly SlateTaskTextProjection<Entry, Text>[]
          : Value extends object ? { readonly [Key in keyof Value]: Key extends "kind" | "type" | "case" | "mode" | "environment"
              ? Value[Key]
              : SlateTaskTextProjection<Value[Key], Text> }
            : Value

export type SlateTaskSubagentType<Text extends string | RedactedString = SlateTaskToolText> =
  SlateTaskTextProjection<SlateSubagentType, Text>

export type SlateTaskPlacement<Text extends string | RedactedString = SlateTaskToolText> =
  SlateTaskTextProjection<TaskTargetMachine, Text>

export interface SlateTaskToolArguments<Text extends string | RedactedString = SlateTaskToolText> {
  readonly description: Text
  readonly prompt: Text
  readonly subagentType?: SlateTaskSubagentType<Text>
  readonly model?: Text
  readonly resume?: Text
  readonly agentId?: Text
  readonly attachments: readonly Text[]
  readonly mode: SlateTaskMode
  readonly respondingToMessageIds: readonly string[]
  readonly environment: SlateTaskExecutionEnvironment
  readonly machine?: SlateTaskPlacement<Text>
}

export type SlateTaskToolBackgroundReason = Exclude<SlateTaskBackgroundReason, { readonly kind: "unrecognized" }>

export type SlateTaskToolOutcome<Text extends string | RedactedString = SlateTaskToolText> =
  | { readonly kind: "unknown" }
  | { readonly kind: "error"; readonly message: Text }
  | {
      readonly kind: "success"
      readonly conversationSteps: readonly SlateConversationStep[]
      readonly agentId?: Text
      readonly isBackground: boolean
      readonly durationMs?: bigint
      readonly resultSuffix?: Text
      readonly backgroundReason: SlateTaskToolBackgroundReason
      readonly transcriptUri?: Text
    }

export interface SlateTaskToolCall<Text extends string | RedactedString = SlateTaskToolText> {
  readonly kind: "task"
  readonly args?: SlateTaskToolArguments<Text>
  readonly result?: SlateTaskToolOutcome<Text>
  readonly cloudAgentId?: Text
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function hasOnlyOwnKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys)
  return Object.keys(value).every(key => allowed.has(key))
}

function isText(value: unknown): value is SlateTaskToolText {
  return typeof value === "string" || isRedactedString(value)
}

function isOptional(value: unknown, predicate: (value: unknown) => boolean): boolean {
  return value === undefined || predicate(value)
}

function isSlateTaskSubagentType(value: unknown): boolean {
  if (!isRecord(value) || !hasOnlyOwnKeys(value, ["kind", "customName", "compatibility"]) ||
      typeof value.kind !== "string" || value.kind.trim().length === 0 ||
      !isOptional(value.customName, isText)) return false
  if (value.compatibility === undefined) return true
  return isRecord(value.compatibility) && hasOnlyOwnKeys(value.compatibility, ["legacyDiscriminator"]) &&
    isOptional(value.compatibility.legacyDiscriminator, isText)
}

function isTaskPlacement(value: unknown): boolean {
  if (!isRecord(value) || typeof value.kind !== "string") return false
  switch (value.kind) {
    case "same-device":
      return hasOnlyOwnKeys(value, ["kind"])
    case "cloud-machine":
      return hasOnlyOwnKeys(value, ["kind", "baseBranch", "environmentBuildId"]) &&
        isOptional(value.baseBranch, isText) && isOptional(value.environmentBuildId, isText)
    case "hosted-worker":
      return hasOnlyOwnKeys(value, ["kind", "workerId"]) && isText(value.workerId)
    case "worker-pool":
      return hasOnlyOwnKeys(value, ["kind", "pool", "labels"]) && isOptional(value.pool, isText) &&
        isOptional(value.labels, labels => isRecord(labels) && Object.values(labels).every(isText))
    default:
      return false
  }
}

function isTaskMode(value: unknown): value is SlateTaskMode {
  return value === "unspecified" || value === "agent" || value === "plan"
}

function isTaskEnvironment(value: unknown): value is SlateTaskExecutionEnvironment {
  return value === "unspecified" || value === "local" || value === "cloud"
}

function isTaskStep(value: unknown): boolean {
  if (!isRecord(value)) return false
  switch (value.kind) {
    case "assistant-message":
      return isText(value.text)
    case "thinking-message":
      return isText(value.text) && typeof value.durationMs === "number" && Number.isFinite(value.durationMs)
    case "tool-call":
      return isRecord(value.tool) &&
        (typeof value.tool.kind === "string" || typeof value.tool.case === "string" || value.tool.case === undefined) &&
        (value.toolCallId === undefined || typeof value.toolCallId === "string") &&
        (value.startedAtMs === undefined || typeof value.startedAtMs === "bigint") &&
        (value.completedAtMs === undefined || typeof value.completedAtMs === "bigint") &&
        Array.isArray(value.hookContexts) && value.hookContexts.every(context => isRecord(context) &&
          typeof context.event === "string" && isText(context.text))
    case "unsupported":
      return value.sourceCase === undefined || typeof value.sourceCase === "string"
    default:
      return false
  }
}

function isBackgroundReason(value: unknown): value is SlateTaskToolBackgroundReason {
  return typeof value === "string" && [
    "unspecified", "agent-request", "user-request", "queued-follow-up", "unknown",
  ].includes(value)
}

function isTaskArguments(value: unknown): boolean {
  return isRecord(value) && hasOnlyOwnKeys(value, [
    "description", "prompt", "subagentType", "model", "resume", "agentId", "attachments", "mode",
    "respondingToMessageIds", "environment", "machine",
  ]) && isText(value.description) && isText(value.prompt) &&
    isOptional(value.subagentType, isSlateTaskSubagentType) &&
    isOptional(value.model, isText) && isOptional(value.resume, isText) && isOptional(value.agentId, isText) &&
    Array.isArray(value.attachments) && value.attachments.every(isText) && isTaskMode(value.mode) &&
    Array.isArray(value.respondingToMessageIds) && value.respondingToMessageIds.every(item => typeof item === "string") &&
    isTaskEnvironment(value.environment) && isOptional(value.machine, isTaskPlacement)
}

function isTaskOutcome(value: unknown): boolean {
  if (!isRecord(value)) return false
  switch (value.kind) {
    case "unknown":
      return hasOnlyOwnKeys(value, ["kind"])
    case "error":
      return hasOnlyOwnKeys(value, ["kind", "message"]) && isText(value.message)
    case "success":
      return hasOnlyOwnKeys(value, [
        "kind", "conversationSteps", "agentId", "isBackground", "durationMs", "resultSuffix", "backgroundReason", "transcriptUri",
      ]) && Array.isArray(value.conversationSteps) && value.conversationSteps.every(isTaskStep) &&
        isOptional(value.agentId, isText) && typeof value.isBackground === "boolean" &&
        isOptional(value.durationMs, candidate => typeof candidate === "bigint") &&
        isOptional(value.resultSuffix, isText) && isBackgroundReason(value.backgroundReason) &&
        isOptional(value.transcriptUri, isText)
    default:
      return false
  }
}

/** Validates the complete Slate task call stored in a conversation step. */
export function isSlateTaskToolCall(value: unknown): value is SlateTaskToolCall<SlateTaskToolText> {
  return isRecord(value) && hasOnlyOwnKeys(value, ["kind", "args", "result", "cloudAgentId"]) &&
    value.kind === "task" && isOptional(value.args, isTaskArguments) &&
    isOptional(value.result, isTaskOutcome) && isOptional(value.cloudAgentId, isText)
}
