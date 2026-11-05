import { cloneSlateUserMessage, type SlateUserMessage } from "../user-message-state.ts"
import type { SlateTaskConversationState } from "../subagent-persisted-state.ts"
import type { SlateSubagentType } from "../subagent-type.ts"
import { cloneTaskTargetMachine, type SlatePreparedTaskRawArgs } from "./task-runtime-types.ts"

/** Attachment slots owned by task preparation; each item remains at its media-provider boundary. */
export interface SlateTaskAttachmentSelection {
  readonly selectedImages: readonly unknown[]
  readonly selectedVideos: readonly unknown[]
  readonly cursorCommands: readonly unknown[]
}

/** Slate's in-memory handoff from task resolution to the subagent run loop. */
export interface SlatePreparedTask {
  readonly agentId: string
  readonly typeName: string
  readonly type: SlateSubagentType
  readonly analyticsType: string
  readonly modelId: string
  readonly isReadOnly: boolean
  readonly useChatMode: boolean
  readonly conversationSnapshot: SlateTaskConversationState
  readonly firstMessage: SlateUserMessage
  readonly startingTurnCount: number
  readonly requestId: string
  readonly toolCallId: string
  readonly isResuming: boolean
  readonly cloudAgentId?: string
  readonly parentRequestId?: string
  readonly rootParentRequestId?: string
  readonly prompt: string
  readonly description: string
  /** Selected media remains opaque until the attachment protocol receives its own Slate model. */
  readonly attachmentSelection?: SlateTaskAttachmentSelection
  readonly plugin?: string
  readonly marketplace?: string
  readonly pluginId?: string
  readonly marketplaceId?: string
  readonly source?: string
  readonly request: SlatePreparedTaskRawArgs
  readonly parentModelName: string
  /** Provider credential variants are projected at the provider boundary and are not inspected here. */
  readonly credentials?: unknown
  readonly resultSuffix?: string
  readonly allowExecuteHook: boolean
  readonly configuredSteps: readonly string[]
  readonly readonlyShellEnabled: boolean
  readonly toolName: string
  readonly preparedAtMs: bigint
}

/** Hook input keeps its established public field names while reading only Slate request values. */
export interface SlatePreparedTaskHookInput {
  readonly description: string | undefined
  readonly prompt: string | undefined
  readonly model: string | undefined
  readonly resume: string | undefined
  readonly environment: SlatePreparedTaskRawArgs["environment"]
  readonly cloud_base_branch: string | undefined
  readonly cloud_requested_environment_build_id: string | undefined
  readonly machine: SlatePreparedTaskRawArgs["targetMachine"] | undefined
  readonly subagent_type: string
  readonly run_in_background: boolean | undefined
  readonly file_attachments: readonly string[] | undefined
}

/** Projects the normalized Slate task request into the hook's established input shape. */
export function buildSlatePreparedTaskHookInput(input: {
  readonly typeName: string
  readonly request?: SlatePreparedTaskRawArgs
}): SlatePreparedTaskHookInput {
  const request = input.request
  if (request === undefined) {
    return {
      description: undefined,
      prompt: undefined,
      model: undefined,
      resume: undefined,
      environment: undefined,
      cloud_base_branch: undefined,
      cloud_requested_environment_build_id: undefined,
      machine: undefined,
      subagent_type: input.typeName,
      run_in_background: undefined,
      file_attachments: undefined,
    }
  }
  return {
    description: request.description,
    prompt: request.prompt,
    model: request.model,
    resume: request.resume,
    environment: request.environment,
    cloud_base_branch: request.cloudBaseBranch,
    cloud_requested_environment_build_id: request.requestedRuntimeBuildId,
    machine: request.targetMachine,
    subagent_type: input.typeName,
    run_in_background: request.runInBackground,
    file_attachments: request.attachments.length > 0 ? request.attachments : undefined,
  }
}

/** Owns mutable copies of request lists and message bytes at the handoff boundary. */
export function createSlatePreparedTask(input: SlatePreparedTask): SlatePreparedTask {
  return {
    ...input,
    conversationSnapshot: {
      ...input.conversationSnapshot,
      turns: input.conversationSnapshot.turns.map(turn => new Uint8Array(turn)),
    },
    firstMessage: cloneSlateUserMessage(input.firstMessage),
    request: {
      ...input.request,
      attachments: [...input.request.attachments],
      targetMachine: cloneTaskTargetMachine(input.request.targetMachine),
    },
    configuredSteps: [...input.configuredSteps],
  }
}
