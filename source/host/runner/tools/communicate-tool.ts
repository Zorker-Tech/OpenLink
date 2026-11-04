import type { ZodTypeAny } from "zod"
import type { Context } from "../../../packages/context/context.ts"
import { createStringResult } from "../../../packages/chat-inference/prompt-executor.ts"
import {
  buildErrorResult,
  buildSuccessResult,
  completedToolCall,
  emptyToolCall,
  serializedErrorToolCall,
  toolCallWrapper,
  type CommunicateResult,
  type CommunicateToolCall,
} from "../../../adapters/interop/agent/communicate-tool-protocol-adapter.ts"
import {
  createZodAgentTool,
  withSafeParsedArgs,
} from "../../../packages/agent/tools/tool-support.ts"

export interface CommunicateActivity {
  readonly detail?: string
  readonly target?: string
}

export interface CommunicateInteractionHandler {
  executeToolCall<Result>(
    context: Context,
    startedCall: CommunicateToolCall,
    callId: string,
    execute: (context: Context) => Promise<Result>,
    complete: (outcome: Result) => CommunicateToolCall,
  ): Promise<Result>
}

export interface CommunicateToolSpec<Arguments, Dependencies extends object> {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly parameters: ZodTypeAny
  readonly describeActivity?: (stepArguments: Arguments) => CommunicateActivity
  execute(
    context: Context,
    stepArguments: Arguments,
    capabilities: Dependencies & { readonly toolCallId: string },
  ): Promise<string>
}

function failureMessage(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure)
}

export function makeCommunicateRender() {
  return async (_context: Context, emitted: CommunicateResult) => {
    if (emitted.result.case === "error") {
      return createStringResult(`Error: ${emitted.result.value.error}`)
    }
    if (emitted.result.case !== "success") return createStringResult("Tool completed.")
    const text = emitted.result.value.currentStep
    return createStringResult(text.length === 0 ? "Tool completed." : text)
  }
}

export function defineCommunicateTool<Arguments, Dependencies extends object>(
  capabilities: Dependencies,
  specification: CommunicateToolSpec<Arguments, Dependencies>,
) {
  return createZodAgentTool(specification.id, {
    name: specification.name,
    descriptionGenerator: () => specification.description,
    parameters: specification.parameters,
    execute: withSafeParsedArgs(
      specification.parameters,
      async (
        context: Context,
        interactionHandlerValue: unknown,
        parsedArgumentsValue: unknown,
        call: { readonly toolCallId: string },
      ) => {
        const interactionHandler = interactionHandlerValue as CommunicateInteractionHandler
        const parsedArguments = parsedArgumentsValue as Arguments
        const activity = specification.describeActivity?.(parsedArguments)
        const startedCall = toolCallWrapper({
          phase: "executing",
          tool: specification.name,
          ...(activity?.detail == null || activity.detail.length === 0
            ? {}
            : { detail: activity.detail }),
          ...(activity?.target == null || activity.target.length === 0
            ? {}
            : { target: activity.target }),
        })
        return interactionHandler.executeToolCall(
          context,
          startedCall,
          call.toolCallId,
          async () => {
            try {
              return buildSuccessResult(
                await specification.execute(context, parsedArguments, {
                  ...capabilities,
                  toolCallId: call.toolCallId,
                }),
              )
            } catch (failure) {
              return buildErrorResult(failureMessage(failure))
            }
          },
          completedToolCall,
        )
      },
      emptyToolCall(),
      { emitInitialPartialToolCall: false },
    ),
    render: makeCommunicateRender(),
    serializeError(failure: unknown) {
      return serializedErrorToolCall(failureMessage(failure))
    },
  })
}
