import type { RedactedString } from "../redaction/redacted-values.ts"
import type { SlateMode } from "./mode-processing.ts"

export type SlateUserMessageText = string | RedactedString

export interface SlateTriggeringActor {
  readonly authId?: string
  readonly userId?: number
}

export type SlateSubscriptionSource =
  | "unspecified"
  | "slack"
  | "github"
  | "linear"
  | "origin"
  | `unknown-${number}`

export interface SlateSubscriptionEventDisplay {
  readonly label?: SlateUserMessageText
  readonly resourceUrl?: SlateUserMessageText
  readonly subscriptionId?: string
}

export interface SlateSimulationDetails {
  readonly title?: SlateUserMessageText
  readonly taskId?: string
  readonly findingAction?: string
  readonly url?: SlateUserMessageText
  readonly subscriptionSource?: SlateSubscriptionSource
  readonly subscriptionEvent?: SlateSubscriptionEventDisplay
}

export type SlateCustomModeSource =
  | "unspecified"
  | "agent-skill"
  | "plugin-skill"
  | "repository-skill"
  | "managed-skill"
  | `unknown-${number}`

export interface SlateSubmittedCustomMode {
  readonly id: SlateUserMessageText
  readonly label: string
  readonly source: SlateCustomModeSource
  readonly sourcePath?: SlateUserMessageText
  readonly sourceHash?: string
  readonly managedSkillId?: string
  readonly pluginId?: string
  readonly pluginSnapshotToken?: SlateUserMessageText
}

export interface SlateExitedCustomMode {
  readonly id: SlateUserMessageText
  readonly label: string
}

export type SlateCustomModeNextMode = SlateMode | { readonly kind: "unrecognized"; readonly code: number }

export type SlateCustomModeIntent =
  | { readonly kind: "unspecified" }
  | { readonly kind: "enter"; readonly mode: SlateSubmittedCustomMode }
  | {
      readonly kind: "exit"
      readonly nextMode: SlateCustomModeNextMode
      readonly exitedMode?: SlateExitedCustomMode
    }

export function cloneSlateSimulationDetails(value: SlateSimulationDetails): SlateSimulationDetails {
  return {
    ...(value.title === undefined ? {} : { title: value.title }),
    ...(value.taskId === undefined ? {} : { taskId: value.taskId }),
    ...(value.findingAction === undefined ? {} : { findingAction: value.findingAction }),
    ...(value.url === undefined ? {} : { url: value.url }),
    ...(value.subscriptionSource === undefined ? {} : { subscriptionSource: value.subscriptionSource }),
    ...(value.subscriptionEvent === undefined
      ? {}
      : {
          subscriptionEvent: {
            ...(value.subscriptionEvent.label === undefined ? {} : { label: value.subscriptionEvent.label }),
            ...(value.subscriptionEvent.resourceUrl === undefined ? {} : { resourceUrl: value.subscriptionEvent.resourceUrl }),
            ...(value.subscriptionEvent.subscriptionId === undefined ? {} : { subscriptionId: value.subscriptionEvent.subscriptionId }),
          },
        }),
  }
}

export function cloneSlateCustomModeIntent(value: SlateCustomModeIntent): SlateCustomModeIntent {
  switch (value.kind) {
    case "unspecified":
      return { kind: "unspecified" }
    case "enter":
      return { kind: "enter", mode: { ...value.mode } }
    case "exit":
      return {
        kind: "exit",
        nextMode: typeof value.nextMode === "string" ? value.nextMode : { ...value.nextMode },
        ...(value.exitedMode === undefined ? {} : { exitedMode: { ...value.exitedMode } }),
      }
  }
}
