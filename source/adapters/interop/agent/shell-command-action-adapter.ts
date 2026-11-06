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
import { DataClassification, PrivacyCapability } from "../../../packages/redaction/classification.ts";
import { createRedactedString } from "../../../packages/redaction/create.ts";
import { isRedactedString } from "../../../packages/redaction/redacted-values.ts";
import { PrivacyMode } from "../../../packages/redaction/privacy-mode.ts";
import type { Context } from "../../../packages/context/context.ts";
import { formatShellResult, formatShellResultForVersion } from "../../../packages/agent/tools/core/shell/formatters.ts";
import { renderInteropUserInfo, type InteropUserInfoInput } from "./user-info-input-adapter.ts";
import { buildUserInfoAgentNotesProps } from "./meta-agent-notes-adapter.ts";
import { toInteropAgentMode } from "./mode-processing-adapter.ts";
import {
  createSlateShellInvocation,
  createSlateShellResult,
  storeSlateShellInvocation,
  storeSlateShellResult,
  type SlateStoredShellResult,
} from "../../../packages/agent/shell-state.ts";
import {
  createSlateShellCommandActionPayload,
  isSlateShellCommandActionPayload,
  type SlateShellCommandActionPayload,
} from "../../../packages/agent/actions/shell-command-action-contracts.ts";
import { SlateMode, type SlateMode as SlateModeValue } from "../../../packages/agent/mode-processing.ts";

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
  promptMode(stateHandler: Any): SlateModeValue;
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

type ShellActionUserInfoInput = Omit<InteropUserInfoInput, "cursorRules" | "mode"> & {
  readonly rules?: InteropUserInfoInput["cursorRules"]
  readonly mode: SlateModeValue
}

/** Maps Slate prompt inputs to the generated field names expected by the installed prompt builder. */
export function toShellSystemPromptOptions(input: {
  readonly requestContext: unknown;
  readonly rules: unknown;
  readonly env: unknown;
  readonly browserTools: readonly string[];
  readonly cloudRule: unknown;
  readonly mode: SlateModeValue;
}) {
  return {
    requestContext: input.requestContext,
    cursorRules: input.rules,
    env: input.env,
    browserTools: input.browserTools,
    cloudRule: input.cloudRule,
    mode: toInteropAgentMode(input.mode),
  };
}

/** Projects Slate rule inputs through the user-info interop boundary. */
export function renderShellActionUserInfo(
  input: ShellActionUserInfoInput,
): string {
  const { rules, mode, ...rest } = input;
  return renderInteropUserInfo({ ...rest, cursorRules: rules, mode: toInteropAgentMode(mode) });
}

/** Projects Slate mode before reading the model-visible notes settings. */
export function buildShellActionUserInfoAgentNotesProps(
  config: Parameters<typeof buildUserInfoAgentNotesProps>[0],
  mode: SlateModeValue,
  env: Parameters<typeof buildUserInfoAgentNotesProps>[2],
): ReturnType<typeof buildUserInfoAgentNotesProps> {
  return buildUserInfoAgentNotesProps(config, toInteropAgentMode(mode), env);
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

/** Projects a historical shell route into the versioned Slate command action. */
export function slateShellCommandActionPayloadFromRedacted(
  value: Readonly<Record<string, unknown>> | undefined,
  privacyMode: PrivacyMode,
): SlateShellCommandActionPayload {
  const shellCommand = isRecord(value?.shellCommand) ? value.shellCommand : undefined;
  const commandValue = shellCommand?.command;
  const commandText = shellCommand === undefined
    ? undefined
    : isRedactedString(commandValue)
      ? commandValue
      : createRedactedString(
          typeof commandValue === "string" ? commandValue : "",
          DataClassification.CODE,
          "command",
          privacyMode,
        );
  const compatibility = value === undefined ? undefined : { legacyPayload: value };
  return createSlateShellCommandActionPayload({
    privacyMode,
    ...(commandText === undefined ? {} : { commandText }),
    ...(typeof value?.execId === "string" ? { resumeExecutionId: value.execId } : {}),
    ...(compatibility === undefined ? {} : { compatibility }),
  });
}

/** Projects the Slate command into the interop operations used to run and record the shell turn. */
export function adaptShellCommandAction(action: SlateShellCommandActionPayload): ShellCommandActionInteropHandle | undefined {
  if (!isSlateShellCommandActionPayload(action) || action.commandText === undefined) return undefined;
  const sourceCommand = action.commandText;
  const commandText = isRedactedString(sourceCommand)
    ? sourceCommand.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED)
    : sourceCommand;
  const redactedCommand = createRedactedString(
    commandText,
    isRedactedString(sourceCommand) ? sourceCommand.__classification : DataClassification.CODE,
    isRedactedString(sourceCommand) ? sourceCommand.__fieldName : "command",
    action.privacyMode,
  );
  const privacyMode = action.privacyMode;
  const shellInvocation = storeSlateShellInvocation(
    createSlateShellInvocation(commandText),
    privacyMode,
  );
  const execId = action.resumeExecutionId;

  return {
    commandText,
    ...(execId === undefined ? {} : { execId }),
    privacyMode,
    promptMode: (stateHandler) => stateHandler.mode ?? SlateMode.AGENT,
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
