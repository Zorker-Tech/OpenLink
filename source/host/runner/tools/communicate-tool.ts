/**
 * The tool an agent uses to say something outside its own conversation.
 *
 * What it says goes to the channel it names — the chat, a room, another agent — and the answer tells it whether the
 * message was delivered, so an agent does not assume it was heard.
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

export function encodeSlateStep(payload: Readonly<Record<string, unknown>>): string {
  return JSON.stringify({ [SLATE_TOOL_MARKER]: true, ...payload });
}

export function toolCallWrapper(payload: Readonly<Record<string, unknown>>): ToolCall {
  return new ToolCall({
    tool: {
      case: "communicateUpdateToolCall",
      value: new CommunicateUpdateToolCall({
        args: new CommunicateUpdateArgs({ currentStep: encodeSlateStep(payload) }),
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

export function encodeError(message: string): CommunicateUpdateArgs {
  return new CommunicateUpdateArgs({ currentStep: encodeSlateStep({ error: message }) });
}

export function encodeSuccess(result: string): CommunicateUpdateArgs {
  return new CommunicateUpdateArgs({ currentStep: encodeSlateStep({ result }) });
}

export function buildSuccessResult(text: string): CommunicateUpdateResult {
  return new CommunicateUpdateResult({
    result: {
      case: "success",
      value: new CommunicateUpdateSuccess({ currentStep: text }),
    },
  });
}

export function buildErrorResult(message: string): CommunicateUpdateResult {
  return new CommunicateUpdateResult({
    result: {
      case: "error",
      value: new CommunicateUpdateError({ error: message }),
    },
  });
}

export function completedToolCall(result: CommunicateUpdateResult): ToolCall {
  const args = result.result.case === "error"
    ? encodeError(result.result.value.error || "Tool failed.")
    : encodeSuccess(result.result.case === "success" ? result.result.value.currentStep : "");
  return new ToolCall({
    tool: {
      case: "communicateUpdateToolCall",
      value: new CommunicateUpdateToolCall({ args, result }),
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
    initial: ToolCall,
    toolCallId: string,
    execute: (context: Context) => Promise<Result>,
    complete: (result: Result) => ToolCall,
  ): Promise<Result>;
}

export interface CommunicateToolSpec<Args, Dependencies extends object> {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly parameters: ZodTypeAny;
  readonly describeActivity?: (args: Args) => CommunicateActivity;
  execute(
    context: Context,
    args: Args,
    dependencies: Dependencies & { readonly toolCallId: string },
  ): Promise<string>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function makeRender() {
  return async (_context: Context, output: CommunicateUpdateResult) => {
    if (output.result.case === "error") {
      return createStringResult(`Error: ${output.result.value.error}`);
    }
    if (output.result.case !== "success") return createStringResult("Tool completed.");
    const raw = output.result.value.currentStep;
    return createStringResult(raw.length === 0 ? "Tool completed." : raw);
  };
}

export function defineCommunicateTool<Args, Dependencies extends object>(
  dependencies: Dependencies,
  spec: CommunicateToolSpec<Args, Dependencies>,
) {
  return createZodAgentTool(spec.id, {
    name: spec.name,
    descriptionGenerator: () => spec.description,
    parameters: spec.parameters,
    execute: withSafeParsedArgs(
      spec.parameters,
      // The wrapper declares the handler and the parsed arguments as unknown, so both are asserted once here and
      // the body below is the reference's.
      async (
        ctx: Context,
        rawHandler: unknown,
        rawArgs: unknown,
        meta: { readonly toolCallId: string },
      ) => {
        const interactionHandler = rawHandler as CommunicateInteractionHandler;
        const parsedArgs = rawArgs as Args;
        const activity = spec.describeActivity?.(parsedArgs);
        const initial = toolCallWrapper({
          phase: "executing",
          tool: spec.name,
          ...(activity?.detail != null && activity.detail.length > 0 ? { detail: activity.detail } : {}),
          ...(activity?.target != null && activity.target.length > 0 ? { target: activity.target } : {}),
        });
        return interactionHandler.executeToolCall(
          ctx,
          initial,
          meta.toolCallId,
          async () => {
            try {
              return buildSuccessResult(await spec.execute(ctx, parsedArgs, {
                ...dependencies,
                toolCallId: meta.toolCallId,
              }));
            } catch (error) {
              return buildErrorResult(errorMessage(error));
            }
          },
          completedToolCall,
        );
      },
      emptyToolCall(),
      { emitInitialPartialToolCall: false },
    ),
    render: makeRender(),
    serializeError(error: unknown): ToolCall {
      const message = errorMessage(error);
      return new ToolCall({
        tool: {
          case: "communicateUpdateToolCall",
          value: new CommunicateUpdateToolCall({
            args: encodeError(message),
            result: buildErrorResult(message),
          }),
        },
      });
    },
  });
}
