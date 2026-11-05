import { AgentMode } from "../proto/generated/agent/v1/agent_pb.ts";
import {
  createRedactedShellArgs,
  createRedactedShellCommandParsingResult,
  createRedactedShellStreamExit,
  createRedactedShellStreamStderr,
  createRedactedShellStreamStart,
  createRedactedShellStreamStdout,
  fromRedactedShellArgs,
  toRedactedShellStream,
} from "../redacted-protos/generated/agent/v1/shell_exec_redacted.ts";
import { RedactedUpdates } from "../../../packages/agent-core/redacted-interaction-updates.ts";
import { shellStreamExecutorResource } from "../../../packages/agent-exec/shell-stream-operation.ts";
import { PrivacyCapability } from "../../../packages/redaction/classification.ts";
import { PrivacyMode } from "../../../packages/redaction/privacy-mode.ts";
import type { Context } from "../../../packages/context/context.ts";
import { formatShellResult, formatShellResultForVersion } from "../../../packages/agent/tools/core/shell/formatters.ts";
import { renderInteropUserInfo, type InteropUserInfoInput } from "./user-info-input-adapter.ts";
import {
  createSlateShellInvocation,
  createSlateShellResult,
  storeSlateShellInvocation,
  storeSlateShellResult,
  type SlateStoredShellResult,
} from "../../../packages/agent/shell-state.ts";

type Any = any;

export interface ShellCommandActionStreamEvent {
  readonly kind: "started" | "stdout" | "stderr" | "exit";
  readonly text?: string;
  readonly code?: number;
  readonly aborted?: boolean;
  readonly interactionUpdate: unknown;
}

export interface ShellCommandActionInteropHandle {
  readonly commandText: string;
  readonly execId?: string;
  readonly privacyMode: PrivacyMode;
  promptMode(stateHandler: Any): AgentMode;
  isLargeContextMode(stateHandler: Any): boolean;
  transcriptView(input: { readonly command: string; readonly output: string; readonly exitCode: number; readonly largeContextMode: boolean }): {
    readonly promptText: string;
    readonly toolName: string;
    readonly resultText: string;
  };
  providerOptionsForPromptPlacement(placement: unknown): Record<string, unknown> | undefined;
  createTurn(ctx: Context, stateHandler: Any): Promise<Any>;
  run(ctx: Context, resourceAccessor: Any): AsyncIterable<ShellCommandActionStreamEvent>;
  createStoredOutput(stdout: string, stderr: string, exitCode: number): SlateStoredShellResult;
}

/** Maps Slate prompt inputs to the generated field names expected by the installed prompt builder. */
export function toShellSystemPromptOptions(input: {
  readonly requestContext: unknown;
  readonly rules: unknown;
  readonly env: unknown;
  readonly browserTools: readonly string[];
  readonly cloudRule: unknown;
  readonly mode: unknown;
}) {
  return {
    requestContext: input.requestContext,
    cursorRules: input.rules,
    env: input.env,
    browserTools: input.browserTools,
    cloudRule: input.cloudRule,
    mode: input.mode,
  };
}

/** Projects Slate rule inputs through the user-info interop boundary. */
export function renderShellActionUserInfo(
  input: Omit<InteropUserInfoInput, "cursorRules"> & { readonly rules?: InteropUserInfoInput["cursorRules"] },
): string {
  const { rules, ...rest } = input;
  return renderInteropUserInfo({ ...rest, cursorRules: rules });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function streamEvents(
  source: AsyncIterable<unknown>,
  privacyMode: PrivacyMode,
): AsyncIterable<ShellCommandActionStreamEvent> {
  return (async function* () {
    for await (const rawEvent of source) {
      const stream = toRedactedShellStream(rawEvent as never, privacyMode);
      const selection = stream.event as Any;
      switch (selection.case) {
        case "start": {
          const value = selection.value;
          yield {
            kind: "started",
            interactionUpdate: RedactedUpdates.shellOutputDelta(stream._privacyMode, {
              case: "start",
              value: createRedactedShellStreamStart(stream._privacyMode, { sandboxPolicy: value.sandboxPolicy }),
            }),
          };
          break;
        }
        case "stdout": {
          const value = selection.value;
          yield {
            kind: "stdout",
            text: value.data.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED),
            interactionUpdate: RedactedUpdates.shellOutputDelta(stream._privacyMode, {
              case: "stdout",
              value: createRedactedShellStreamStdout(stream._privacyMode, { data: value.data }),
            }),
          };
          break;
        }
        case "stderr": {
          const value = selection.value;
          yield {
            kind: "stderr",
            text: value.data.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED),
            interactionUpdate: RedactedUpdates.shellOutputDelta(stream._privacyMode, {
              case: "stderr",
              value: createRedactedShellStreamStderr(stream._privacyMode, { data: value.data }),
            }),
          };
          break;
        }
        case "exit": {
          const value = selection.value;
          yield {
            kind: "exit",
            code: value.code,
            aborted: value.aborted,
            interactionUpdate: RedactedUpdates.shellOutputDelta(stream._privacyMode, {
              case: "exit",
              value: createRedactedShellStreamExit(stream._privacyMode, {
                code: value.code,
                aborted: value.aborted,
              }),
            }),
          };
          break;
        }
      }
    }
  })();
}

/** Decodes one action invocation and keeps its generated message details behind closures. */
export function adaptShellCommandAction(action: unknown): ShellCommandActionInteropHandle | undefined {
  if (!isRecord(action) || !isRecord(action.shellCommand)) return undefined;
  const redactedCommand = (action.shellCommand as Record<string, unknown>).command as {
    unwrap(capability: PrivacyCapability): string;
  } | undefined;
  if (redactedCommand == null || typeof redactedCommand.unwrap !== "function") return undefined;
  const privacyMode = action._privacyMode as PrivacyMode;
  const shellInvocation = storeSlateShellInvocation(
    createSlateShellInvocation(redactedCommand.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED)),
    privacyMode,
  );
  const execId = typeof action.execId === "string" ? action.execId : undefined;

  return {
    commandText: redactedCommand.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED),
    ...(execId === undefined ? {} : { execId }),
    privacyMode,
    promptMode: (stateHandler) => stateHandler.mode ?? AgentMode.AGENT,
    isLargeContextMode: (stateHandler) => stateHandler.usesLargeContextTreatment(),
    transcriptView({ command, output, exitCode, largeContextMode }) {
      const basePrompt = `Run the following command: ${command}`;
      return {
        promptText: largeContextMode ? `<user_query>\n${basePrompt}\n</user_query>` : basePrompt,
        toolName: largeContextMode ? "run_terminal_cmd" : "Shell",
        resultText: largeContextMode
          ? formatShellResultForVersion({ combinedOutput: output, exitCode, command }, command)
          : formatShellResult({ combinedOutput: output, exitCode }),
      };
    },
    providerOptionsForPromptPlacement(placement) {
      return placement === undefined
        ? undefined
        : { providerOptions: { cursor: { composer2CloudTestingSectionsPlacement: placement } } };
    },
    createTurn: (ctx, stateHandler) => stateHandler.createShellTurn(ctx, shellInvocation),
    run(ctx, resourceAccessor) {
      const shellExecutor = resourceAccessor.get(shellStreamExecutorResource);
      const redactedArgs = createRedactedShellArgs(privacyMode, {
        command: redactedCommand,
        parsingResult: createRedactedShellCommandParsingResult(privacyMode, {}),
        // The user typed this command themselves, so it needs no approval check.
        skipApproval: true,
      });
      const stream = shellExecutor.execute(
        ctx,
        fromRedactedShellArgs(redactedArgs, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED, undefined),
        { execId },
      );
      return streamEvents(stream, privacyMode);
    },
    createStoredOutput(stdout, stderr, exitCode) {
      return storeSlateShellResult(
        createSlateShellResult({ standardOutput: stdout, standardError: stderr, exitCode }),
        privacyMode,
      );
    },
  };
}
