import { Struct } from "@bufbuild/protobuf"
import {
  AfterAgentThoughtRequestQuery,
  PostToolUseFailureRequestQuery,
  PostToolUseRequestQuery,
  PreToolUseRequestQuery,
  RequestedModel_ModelParameterValue,
  SubagentStartRequestQuery,
  SubagentStopRequestQuery,
} from "../proto/generated/agent/v1/agent_pb.ts"
import { ExecuteHookArgs, ExecuteHookRequest } from "../proto/generated/agent/v1/exec_pb.ts"
import type { Context } from "../../../packages/context/context.ts"

export interface RemoteHookResponseView {
  readonly kind?: string
  readonly permission?: string
  readonly userMessage?: string
  readonly agentMessage?: string
  readonly followupMessage?: string
  readonly updatedInput?: string
  readonly additionalContext?: string
}

function jsonStruct(value: unknown): Struct {
  return Struct.fromJson(JSON.parse(JSON.stringify(value)) as never)
}

function modelParameters(value: unknown): RequestedModel_ModelParameterValue[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined
  return value.map((entry) => new RequestedModel_ModelParameterValue(entry as never))
}

function requestFor(step: string, fields: Record<string, unknown>): ExecuteHookRequest {
  const modelParams = modelParameters(fields.modelParams)
  const common = {
    conversationId: fields.conversationId as string,
    generationId: fields.generationId as string,
    ...(typeof fields.model === "string" ? { model: fields.model } : {}),
    ...(fields.modelId === undefined ? {} : { modelId: fields.modelId as string }),
    ...(modelParams === undefined ? {} : { modelParams }),
  }
  switch (step) {
    case "afterAgentThought":
      return new ExecuteHookRequest({
        request: {
          case: "afterAgentThought",
          value: new AfterAgentThoughtRequestQuery({
            text: fields.text as string,
            ...(fields.durationMs === undefined ? {} : { durationMs: BigInt(fields.durationMs as number) }),
            ...common,
          }),
        },
      })
    case "subagentStart":
      return new ExecuteHookRequest({
        request: {
          case: "subagentStart",
          value: new SubagentStartRequestQuery({
            subagentId: fields.subagentId as string,
            subagentType: fields.subagentType as string,
            task: fields.task as string,
            parentConversationId: fields.parentConversationId as string,
            toolCallId: fields.toolCallId as string,
            ...(typeof fields.subagentModel === "string" ? { subagentModel: fields.subagentModel } : {}),
            isParallelWorker: fields.isParallelWorker as boolean,
            ...(typeof fields.gitBranch === "string" ? { gitBranch: fields.gitBranch } : {}),
            ...common,
          }),
        },
      })
    case "subagentStop":
      return new ExecuteHookRequest({
        request: {
          case: "subagentStop",
          value: new SubagentStopRequestQuery({
            subagentId: fields.subagentId as string,
            subagentType: fields.subagentType as string,
            status: fields.status as string,
            durationMs: BigInt(Math.round(fields.durationMs as number)),
            ...(typeof fields.summary === "string" ? { summary: fields.summary } : {}),
            parentConversationId: fields.parentConversationId as string,
            messageCount: fields.messageCount as number,
            toolCallCount: fields.toolCallCount as number,
            ...(typeof fields.errorMessage === "string" ? { errorMessage: fields.errorMessage } : {}),
            ...(Array.isArray(fields.modifiedFiles) ? { modifiedFiles: fields.modifiedFiles as string[] } : {}),
            ...(typeof fields.gitBranch === "string" ? { gitBranch: fields.gitBranch } : {}),
            loopCount: fields.loopCount as number,
            task: fields.task as string,
            ...(typeof fields.description === "string" ? { description: fields.description } : {}),
            ...common,
          }),
        },
      })
    case "preToolUse":
      return new ExecuteHookRequest({
        request: {
          case: "preToolUse",
          value: new PreToolUseRequestQuery({
            toolName: fields.toolName as string,
            toolInput: jsonStruct(fields.toolInput),
            toolUseId: fields.toolUseId as string,
            ...common,
          }),
        },
      })
    case "postToolUse":
      return new ExecuteHookRequest({
        request: {
          case: "postToolUse",
          value: new PostToolUseRequestQuery({
            toolName: fields.toolName as string,
            toolInput: jsonStruct(fields.toolInput),
            toolOutput: fields.toolOutput as string,
            durationMs: BigInt(Math.round(fields.durationMs as number)),
            toolUseId: fields.toolUseId as string,
            ...common,
          }),
        },
      })
    case "postToolUseFailure":
      return new ExecuteHookRequest({
        request: {
          case: "postToolUseFailure",
          value: new PostToolUseFailureRequestQuery({
            toolName: fields.toolName as string,
            toolInput: jsonStruct(fields.toolInput),
            errorMessage: fields.errorMessage as string,
            failureType: fields.failureType as string,
            durationMs: BigInt(Math.round(fields.durationMs as number)),
            toolUseId: fields.toolUseId as string,
            isInterrupt: fields.isInterrupt as boolean,
            ...common,
          }),
        },
      })
    default:
      throw new Error("Unsupported remote hook step: " + step)
  }
}

/** Sends a Slate hook request through the generated executor protocol and projects its response fields. */
export async function executeRemoteHookInterop(
  ctx: Context,
  executor: unknown,
  step: string,
  fields: Record<string, unknown>,
): Promise<RemoteHookResponseView> {
  const args = new ExecuteHookArgs({ request: requestFor(step, fields) })
  const result = await (executor as { execute(ctx: Context, args: unknown): Promise<unknown> }).execute(ctx, args)
  const response = (result as { readonly response?: { readonly response?: { readonly case?: string; readonly value?: Record<string, unknown> } } } | undefined)?.response?.response
  if (response === undefined || response.case === undefined) return {}
  const value = response.value ?? {}
  switch (response.case) {
    case "subagentStart":
      return {
        kind: response.case,
        ...(typeof value.permission === "string" ? { permission: value.permission } : {}),
        ...(typeof value.userMessage === "string" ? { userMessage: value.userMessage } : {}),
        ...(typeof value.additionalContext === "string" ? { additionalContext: value.additionalContext } : {}),
      }
    case "subagentStop":
      return {
        kind: response.case,
        ...(typeof value.followupMessage === "string" ? { followupMessage: value.followupMessage } : {}),
      }
    case "preToolUse":
      return {
        kind: response.case,
        ...(typeof value.permission === "string" ? { permission: value.permission } : {}),
        ...(typeof value.userMessage === "string" ? { userMessage: value.userMessage } : {}),
        ...(typeof value.agentMessage === "string" ? { agentMessage: value.agentMessage } : {}),
        ...(typeof value.updatedInput === "string" ? { updatedInput: value.updatedInput } : {}),
        ...(typeof value.additionalContext === "string" ? { additionalContext: value.additionalContext } : {}),
      }
    case "postToolUse":
    case "postToolUseFailure":
      return { kind: response.case, ...(typeof value.additionalContext === "string" ? { additionalContext: value.additionalContext } : {}) }
    default:
      return { kind: response.case }
  }
}
