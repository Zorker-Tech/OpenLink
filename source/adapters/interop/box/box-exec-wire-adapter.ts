/** Projects the Slate box-exec stream to the generated resource-accessor envelopes. */
import type { Context } from "../../../packages/context/context.ts";
import {
  ExecClientControlMessage,
  ExecClientMessage,
  ExecClientStreamClose,
  ExecClientThrow,
  type ExecServerMessage,
} from "../proto/generated/agent/v1/exec_pb.ts";
import { ReadArgs } from "../proto/generated/agent/v1/read_exec_pb.ts";
import {
  ShellArgs,
  ShellFailure,
  ShellResult,
  ShellSpawnError,
  ShellStream,
  ShellStreamExit,
  ShellStreamStart,
  ShellStreamStderr,
  ShellStreamStdout,
  ShellSuccess,
  ShellTimeout,
} from "../proto/generated/agent/v1/shell_exec_pb.ts";
import {
  BackgroundShellSpawnArgs,
  BackgroundShellSpawnError,
  BackgroundShellSpawnResult,
  BackgroundShellSpawnSuccess,
  WriteShellStdinArgs,
  WriteShellStdinError,
  WriteShellStdinResult,
  WriteShellStdinSuccess,
} from "../proto/generated/agent/v1/background_shell_exec_pb.ts";
import {
  SLATE_BOX_EXEC_SCHEMA,
  type BoxExecRequest,
  type BoxExecResponse,
} from "../../../shared/box-exec-protocol.ts";
import type { BoxRemoteExecClient, BoxRemoteExecEnvelope } from "../agent/box-remote-exec-accessor-adapter.ts";
import type { SlateBoxExecClient } from "./slate-box-exec-client.ts";
import type { SlateBoxRequestWithHeaders } from "./slate-box-control-client.ts";
import { readExecutorArgsFromInterop, readExecutorResultToInterop } from "../agent/read-exec-operation-adapter.ts";
import type { ReadExecutorResult } from "../../../packages/agent-exec/read-operation.ts";

export function boxExecRequestFromInterop(message: ExecServerMessage): BoxExecRequest {
  switch (message.message.case) {
    case "readArgs":
    case "redactedReadArgs": {
      const value = message.message.value;
      if (!(value instanceof ReadArgs)) break;
      const args = readExecutorArgsFromInterop(value);
      return {
        schema: SLATE_BOX_EXEC_SCHEMA,
        id: message.id,
        op: "workspace.read",
        redacted: message.message.case === "redactedReadArgs",
        path: args.path,
        ...(args.encodingHint === undefined ? {} : { encodingHint: args.encodingHint }),
        ...(args.offset === undefined ? {} : { offset: args.offset }),
        ...(args.limit === undefined ? {} : { limit: args.limit }),
      };
    }
    case "shellArgs":
    case "miniSweAgentBashArgs": {
      const value = message.message.value;
      if (!(value instanceof ShellArgs)) break;
      return {
        schema: SLATE_BOX_EXEC_SCHEMA,
        id: message.id,
        op: "shell.run",
        variant: message.message.case === "miniSweAgentBashArgs" ? "mini-swe" : "default",
        command: value.command,
        workingDirectory: value.workingDirectory,
        timeout: value.timeout,
      };
    }
    case "shellStreamArgs": {
      const value = message.message.value;
      if (!(value instanceof ShellArgs)) break;
      return {
        schema: SLATE_BOX_EXEC_SCHEMA,
        id: message.id,
        op: "shell.stream",
        command: value.command,
        workingDirectory: value.workingDirectory,
        timeout: value.timeout,
      };
    }
    case "backgroundShellSpawnArgs": {
      const value = message.message.value;
      if (!(value instanceof BackgroundShellSpawnArgs)) break;
      return {
        schema: SLATE_BOX_EXEC_SCHEMA,
        id: message.id,
        op: "shell.background.spawn",
        command: value.command,
        workingDirectory: value.workingDirectory,
      };
    }
    case "writeShellStdinArgs": {
      const value = message.message.value;
      if (!(value instanceof WriteShellStdinArgs)) break;
      return {
        schema: SLATE_BOX_EXEC_SCHEMA,
        id: message.id,
        op: "shell.stdin.write",
        shellId: value.shellId,
        chars: value.chars,
      };
    }
  }
  return {
    schema: SLATE_BOX_EXEC_SCHEMA,
    id: message.id,
    op: "unsupported",
    sourceOperation: message.message.case ?? "unset",
  };
}

function readResultFromBoxProtocol(response: Extract<BoxExecResponse, { kind: "workspace.read" }>['result']): ReadExecutorResult {
  const value = response;
  switch (value.kind) {
    case "success":
      return {
        kind: "success",
        path: value.path,
        output: { kind: "text", text: value.content },
        totalLines: value.totalLines,
        fileSize: BigInt(value.fileSize),
        truncated: value.truncated,
        rangeApplied: value.rangeApplied,
      };
    case "invalid-file":
      return { kind: "invalid-file", path: value.path, reason: value.reason };
    case "rejected":
      return { kind: "rejected", path: value.path, reason: value.reason };
    case "file-not-found":
      return { kind: "not-found", path: value.path };
    case "permission-denied":
      return { kind: "permission-denied", path: value.path };
    case "error":
      return { kind: "error", path: value.path, error: value.error };
  }
}

function readMessage(response: Extract<BoxExecResponse, { kind: "workspace.read" }>): ExecClientMessage {
  const result = readExecutorResultToInterop(readResultFromBoxProtocol(response.result));
  return new ExecClientMessage({
    id: response.id,
    message: {
      case: response.redacted ? "redactedReadResult" : "readResult",
      value: result,
    },
  });
}

function shellResultMessage(response: Extract<BoxExecResponse, { kind: "shell.run" }>): ExecClientMessage {
  const value = response.result;
  let result: ShellResult;
  switch (value.kind) {
    case "spawn-error":
      result = new ShellResult({ result: { case: "spawnError", value: new ShellSpawnError(value) } });
      break;
    case "timeout":
      result = new ShellResult({ result: { case: "timeout", value: new ShellTimeout(value) } });
      break;
    case "success":
      result = new ShellResult({ result: { case: "success", value: new ShellSuccess(value) } });
      break;
    case "failure":
      result = new ShellResult({ result: { case: "failure", value: new ShellFailure(value) } });
      break;
  }
  return new ExecClientMessage({
    id: response.id,
    message: {
      case: response.variant === "mini-swe" ? "miniSweAgentBashResult" : "shellResult",
      value: result,
    },
  });
}

function shellStreamMessage(response: Extract<BoxExecResponse, { kind: "shell.stream" }>): ExecClientMessage {
  const event = response.event;
  const value = event.kind === "start"
    ? { case: "start" as const, value: new ShellStreamStart() }
    : event.kind === "stdout"
      ? { case: "stdout" as const, value: new ShellStreamStdout({ data: event.data }) }
      : event.kind === "stderr"
        ? { case: "stderr" as const, value: new ShellStreamStderr({ data: event.data }) }
        : {
            case: "exit" as const,
            value: new ShellStreamExit({
              code: event.code,
              cwd: event.cwd,
              aborted: event.aborted,
              localExecutionTimeMs: event.localExecutionTimeMs,
            }),
          };
  return new ExecClientMessage({
    id: response.id,
    message: { case: "shellStream", value: new ShellStream({ event: value }) },
  });
}

export function boxExecResponseToInterop(
  response: BoxExecResponse,
): BoxRemoteExecEnvelope {
  switch (response.kind) {
    case "workspace.read":
      return { element: { case: "execClientMessage", value: readMessage(response) } };
    case "shell.run":
      return { element: { case: "execClientMessage", value: shellResultMessage(response) } };
    case "shell.stream":
      return { element: { case: "execClientMessage", value: shellStreamMessage(response) } };
    case "shell.background.spawn": {
      const result = response.result.kind === "success"
        ? new BackgroundShellSpawnResult({
            result: {
              case: "success",
              value: new BackgroundShellSpawnSuccess({
                shellId: response.result.shellId,
                command: response.result.command,
                workingDirectory: response.result.workingDirectory,
                ...(response.result.pid === undefined ? {} : { pid: response.result.pid }),
              }),
            },
          })
        : new BackgroundShellSpawnResult({
            result: { case: "error", value: new BackgroundShellSpawnError(response.result) },
          });
      return {
        element: {
          case: "execClientMessage",
          value: new ExecClientMessage({ id: response.id, message: { case: "backgroundShellSpawnResult", value: result } }),
        },
      };
    }
    case "shell.stdin.write": {
      const result = response.result.kind === "success"
        ? new WriteShellStdinResult({
            result: { case: "success", value: new WriteShellStdinSuccess(response.result) },
          })
        : new WriteShellStdinResult({
            result: { case: "error", value: new WriteShellStdinError(response.result) },
          });
      return {
        element: {
          case: "execClientMessage",
          value: new ExecClientMessage({ id: response.id, message: { case: "writeShellStdinResult", value: result } }),
        },
      };
    }
    case "control": {
      const value = response.control.kind === "throw"
        ? new ExecClientControlMessage({
            message: {
              case: "throw",
              value: new ExecClientThrow({
                id: response.id,
                error: response.control.error,
                ...(response.control.errorCode === undefined ? {} : { errorCode: response.control.errorCode }),
              }),
            },
          })
        : new ExecClientControlMessage({
            message: { case: "streamClose", value: new ExecClientStreamClose({ id: response.id }) },
          });
      return { element: { case: "execClientControlMessage", value } };
    }
  }
}

export function createSlateBoxRemoteExecClient<Request extends SlateBoxRequestWithHeaders>(
  client: SlateBoxExecClient<Request>,
): BoxRemoteExecClient {
  return {
    async *exec(context: Context, request: ExecServerMessage): AsyncIterable<BoxRemoteExecEnvelope> {
      for await (const response of client.exec(context, boxExecRequestFromInterop(request))) {
        yield boxExecResponseToInterop(response);
      }
    },
  };
}
