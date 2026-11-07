import type { JsonValue } from "@slate/work-domain"
import type { SlateToolCallStep } from "../conversation-step-state.ts"
import type { SlateUserMessage } from "../user-message-state.ts"

/** Opaque bytes held only while the task progress transport is being migrated. */
export interface SlateTaskProgressCompatibility {
  readonly format: "legacy-binary"
  readonly payload: Uint8Array
}

interface SlateTaskProgressBase<Kind extends string> {
  readonly schemaVersion: 1
  readonly kind: Kind
  readonly compatibility?: SlateTaskProgressCompatibility
}

export type SlateTaskProgressUpdate =
  | (SlateTaskProgressBase<"assistant-text"> & {
      readonly text: string
      readonly serverNotice: boolean
    })
  | (SlateTaskProgressBase<"tool-call-started" | "tool-call-completed"> & {
      readonly callId: string
      readonly modelCallId: string
      readonly toolCall?: SlateToolCallStep
    })
  | (SlateTaskProgressBase<"reasoning-text"> & {
      readonly text: string
      readonly style?: number
    })
  | (SlateTaskProgressBase<"reasoning-completed"> & {
      readonly durationMs: number
    })
  | (SlateTaskProgressBase<"user-message-appended"> & {
      readonly message?: SlateUserMessage
    })
  | (SlateTaskProgressBase<"tool-arguments-progress"> & {
      readonly callId: string
      readonly modelCallId: string
      readonly argumentsDelta: string
      readonly toolCall?: SlateToolCallStep
    })
  | (SlateTaskProgressBase<"token-count"> & {
      readonly tokens: number
    })
  | (SlateTaskProgressBase<"summary-progress"> & {
      readonly text: string
    })
  | SlateTaskProgressBase<"summary-started" | "heartbeat">
  | (SlateTaskProgressBase<"summary-completed"> & {
      readonly hookMessage?: string
    })
  | (SlateTaskProgressBase<"shell-output-progress"> & {
      readonly output?: { readonly kind: string; readonly value: JsonValue }
    })
  | (SlateTaskProgressBase<"turn-ended"> & {
      readonly usage?: {
        readonly inputTokens?: string
        readonly outputTokens?: string
        readonly cacheReadTokens?: string
        readonly cacheWriteTokens?: string
        readonly reasoningTokens?: string
      }
    })
  | (SlateTaskProgressBase<"tool-call-progress"> & {
      readonly callId: string
      readonly modelCallId: string
      readonly delta?: JsonValue
    })
  | (SlateTaskProgressBase<"step-started"> & {
      readonly stepId: string
    })
  | (SlateTaskProgressBase<"step-completed"> & {
      readonly stepId: string
      readonly durationMs: string
    })
  | (SlateTaskProgressBase<"prompt-suggestion"> & {
      readonly suggestion: string
    })
  | (SlateTaskProgressBase<"post-request-prompt"> & {
      readonly title: string
      readonly message: string
      readonly buttonLabel: string
      readonly buttonUrl: string
    })
  | (SlateTaskProgressBase<"branch-changed"> & {
      readonly path: string
      readonly branchName: string
    })
  | (SlateTaskProgressBase<"feedback-request"> & {
      readonly requestId: string
      readonly canonicalModelName?: string
      readonly categories: readonly JsonValue[]
      readonly categoryGroups: readonly JsonValue[]
      readonly showImmediately: boolean
      readonly title?: string
      readonly negativeTitle?: string
      readonly commentPlaceholder?: string
    })
  | (SlateTaskProgressBase<"model-comparison"> & {
      readonly comparisonId: string
      readonly event?: { readonly kind: string; readonly value: JsonValue }
    })
  | (SlateTaskProgressBase<"context-injection-state"> & {
      readonly injectionId: string
      readonly state?: { readonly kind: string; readonly value: JsonValue }
    })
  | (SlateTaskProgressBase<"routed-model"> & {
      readonly displayName: string
    })
  | {
      readonly schemaVersion: 1
      readonly kind: "unrecognized"
      readonly compatibility: SlateTaskProgressCompatibility
    }

type SlateTaskProgressViewOf<Value> =
  Value extends { readonly kind: "tool-call-started" | "tool-call-completed"; readonly toolCall?: SlateToolCallStep }
    ? Omit<Value, "compatibility" | "toolCall"> & { readonly toolCall?: JsonValue }
    : Value extends { readonly kind: "tool-arguments-progress"; readonly toolCall?: SlateToolCallStep }
      ? Omit<Value, "compatibility" | "toolCall"> & { readonly toolCall?: JsonValue }
      : Value extends { readonly kind: "user-message-appended"; readonly message?: SlateUserMessage }
        ? Omit<Value, "compatibility" | "message"> & { readonly message?: JsonValue }
        : Value extends { readonly compatibility?: SlateTaskProgressCompatibility }
          ? Omit<Value, "compatibility">
          : never

/** Safe JSON-shaped event fields delivered to the host runner after privacy projection. */
export type SlateTaskProgressUpdateView = SlateTaskProgressUpdate extends infer Update
  ? Update extends unknown ? SlateTaskProgressViewOf<Update> : never
  : never
