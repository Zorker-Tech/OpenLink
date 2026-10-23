/**
 * The tool an agent uses to say something outside its own conversation.
 *
 * What it says goes to the channel it names — the chat, a room, another agent — and the answer tells it whether the
 * text was delivered, so an agent does not assume it was heard.
 */
import type { ZodTypeAny } from "zod";

import type { Context } from "../../../packages/context/context.ts";
import { createStringResult } from "../../../packages/chat-inference/prompt-executor.ts";
import { ToolCall } from "../../../packages/proto/generated/agent/v1/agent_pb.ts";
import {
  CommunicateUpdateArgs,
  CommunicateUpdateError,
  CommunicateUpdateResult,
  CommunicateUpdateSuccess,
  CommunicateUpdateToolCall,
} from "../../../packages/proto/generated/agent/v1/communicate_update_tool_pb.ts";
import { createZodAgentTool, withSafeParsedArgs } from "../../../packages/agent/tools/tool-support.ts";

export const SLATE_TOOL_MARKER = "__slate_tool__";
export type CommunicateResult = CommunicateUpdateResult;
export type CommunicateToolCall = ToolCall;

export function encodeSlateStep(stepData: Readonly<Record<string, unknown>>): string {
  return JSON.stringify({ [SLATE_TOOL_MARKER]: true, ...stepData });
}

export function toolCallWrapper(stepData: Readonly<Record<string, unknown>>): ToolCall {
  return new ToolCall({
    tool: {
      case: "communicateUpdateToolCall",
      value: new CommunicateUpdateToolCall({
        args: new CommunicateUpdateArgs({ currentStep: encodeSlateStep(stepData) }),
      }),
    },
  });
}

export function emptyToolCall(): ToolCall {
  return new ToolCall({
    tool: {
      case: "communicateUpdateToolCall",
      value: new CommunicateUpdateToolCall(),
    },
  });
}

export function encodeError(text: string): CommunicateUpdateArgs {
  return new CommunicateUpdateArgs({ currentStep: encodeSlateStep({ error: text }) });
}

export function encodeSuccess(outcome: string): CommunicateUpdateArgs {
  return new CommunicateUpdateArgs({ currentStep: encodeSlateStep({ result: outcome }) });
}

export function buildSuccessResult(text: string): CommunicateUpdateResult {
  return new CommunicateUpdateResult({
    result: {
      case: "success",
      value: new CommunicateUpdateSuccess({ currentStep: text }),
    },
  });
}

export function buildErrorResult(text: string): CommunicateUpdateResult {
  return new CommunicateUpdateResult({
    result: {
      case: "error",
      value: new CommunicateUpdateError({ error: text }),
    },
  });
}

export function completedToolCall(outcome: CommunicateUpdateResult): ToolCall {
  const stepArgs = outcome.result.case === "error"
    ? encodeError(outcome.result.value.error || "Tool failed.")
    : encodeSuccess(outcome.result.case === "success" ? outcome.result.value.currentStep : "");
  return new ToolCall({
    tool: {
      case: "communicateUpdateToolCall",
      value: new CommunicateUpdateToolCall({ args: stepArgs, result: outcome }),
    },
  });
}

export interface CommunicateActivity {
  readonly detail?: string;
  readonly target?: string;
}

export interface CommunicateInteractionHandler {
  executeToolCall<Result>(
    context: Context,
    startedCall: ToolCall,
    callId: string,
    execute: (context: Context) => Promise<Result>,
    complete: (outcome: Result) => ToolCall,
  ): Promise<Result>;
}

export interface CommunicateToolSpec<Args, Dependencies extends object> {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly parameters: ZodTypeAny;
  readonly describeActivity?: (stepArgs: Args) => CommunicateActivity;
  execute(
    context: Context,
    stepArgs: Args,
    capabilities: Dependencies & { readonly toolCallId: string },
  ): Promise<string>;
}

function messageOf(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure);
}

export function makeRender() {
  return async (_context: Context, emitted: CommunicateUpdateResult) => {
    if (emitted.result.case === "error") {
      return createStringResult(`Error: ${emitted.result.value.error}`);
    }
    if (emitted.result.case !== "success") return createStringResult("Tool completed.");
    const rawText = emitted.result.value.currentStep;
    return createStringResult(rawText.length === 0 ? "Tool completed." : rawText);
  };
}

export function defineCommunicateTool<Args, Dependencies extends object>(
  capabilities: Dependencies,
  toolSpec: CommunicateToolSpec<Args, Dependencies>,
) {
  return createZodAgentTool(toolSpec.id, {
    name: toolSpec.name,
    descriptionGenerator: () => toolSpec.description,
    parameters: toolSpec.parameters,
    execute: withSafeParsedArgs(
      toolSpec.parameters,
      // The wrapper declares the handler and the parsed arguments as unknown, so both are asserted once here and
      // the body below is the reference's.
      async (
        context: Context,
        handler: unknown,
        parsedArguments: unknown,
        call: { readonly toolCallId: string },
      ) => {
        const interactionHandler = handler as CommunicateInteractionHandler;
        const parsedArgs = parsedArguments as Args;
        const described = toolSpec.describeActivity?.(parsedArgs);
        const startedCall = toolCallWrapper({
          phase: "executing",
          tool: toolSpec.name,
          ...(described?.detail != null && described.detail.length > 0 ? { detail: described.detail } : {}),
          ...(described?.target != null && described.target.length > 0 ? { target: described.target } : {}),
        });
        return interactionHandler.executeToolCall(
          context,
          startedCall,
          call.toolCallId,
          async () => {
            try {
              return buildSuccessResult(await toolSpec.execute(context, parsedArgs, {
                ...capabilities,
                toolCallId: call.toolCallId,
              }));
            } catch (failure) {
              return buildErrorResult(messageOf(failure));
            }
          },
          completedToolCall,
        );
      },
      emptyToolCall(),
      { emitInitialPartialToolCall: false },
    ),
    render: makeRender(),
    serializeError(failure: unknown): ToolCall {
      const text = messageOf(failure);
      return new ToolCall({
        tool: {
          case: "communicateUpdateToolCall",
          value: new CommunicateUpdateToolCall({
            args: encodeError(text),
            result: buildErrorResult(text),
          }),
        },
      });
    },
  });
}
