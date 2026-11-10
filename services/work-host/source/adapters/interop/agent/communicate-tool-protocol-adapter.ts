import { ToolCall } from "../proto/generated/agent/v1/agent_pb.ts"
import {
  CommunicateUpdateArgs,
  CommunicateUpdateError,
  CommunicateUpdateResult,
  CommunicateUpdateSuccess,
  CommunicateUpdateToolCall,
} from "../proto/generated/agent/v1/communicate_update_tool_pb.ts"

export const SLATE_TOOL_MARKER = "__slate_tool__"
export type CommunicateResult = CommunicateUpdateResult
export type CommunicateToolCall = ToolCall

export function encodeSlateStep(stepData: Readonly<Record<string, unknown>>): string {
  return JSON.stringify({ [SLATE_TOOL_MARKER]: true, ...stepData })
}

export function toolCallWrapper(stepData: Readonly<Record<string, unknown>>): ToolCall {
  return new ToolCall({
    tool: {
      case: "communicateUpdateToolCall",
      value: new CommunicateUpdateToolCall({
        args: new CommunicateUpdateArgs({ currentStep: encodeSlateStep(stepData) }),
      }),
    },
  })
}

export function emptyToolCall(): ToolCall {
  return new ToolCall({
    tool: {
      case: "communicateUpdateToolCall",
      value: new CommunicateUpdateToolCall(),
    },
  })
}

export function encodeError(text: string): CommunicateUpdateArgs {
  return new CommunicateUpdateArgs({ currentStep: encodeSlateStep({ error: text }) })
}

export function encodeSuccess(outcome: string): CommunicateUpdateArgs {
  return new CommunicateUpdateArgs({ currentStep: encodeSlateStep({ result: outcome }) })
}

export function buildSuccessResult(text: string): CommunicateUpdateResult {
  return new CommunicateUpdateResult({
    result: {
      case: "success",
      value: new CommunicateUpdateSuccess({ currentStep: text }),
    },
  })
}

export function buildErrorResult(text: string): CommunicateUpdateResult {
  return new CommunicateUpdateResult({
    result: {
      case: "error",
      value: new CommunicateUpdateError({ error: text }),
    },
  })
}

export function completedToolCall(outcome: CommunicateUpdateResult): ToolCall {
  const stepArguments = outcome.result.case === "error"
    ? encodeError(outcome.result.value.error || "Tool failed.")
    : encodeSuccess(
        outcome.result.case === "success" ? outcome.result.value.currentStep : "",
      )
  return new ToolCall({
    tool: {
      case: "communicateUpdateToolCall",
      value: new CommunicateUpdateToolCall({
        args: stepArguments,
        result: outcome,
      }),
    },
  })
}

export function serializedErrorToolCall(text: string): ToolCall {
  return new ToolCall({
    tool: {
      case: "communicateUpdateToolCall",
      value: new CommunicateUpdateToolCall({
        args: encodeError(text),
        result: buildErrorResult(text),
      }),
    },
  })
}
