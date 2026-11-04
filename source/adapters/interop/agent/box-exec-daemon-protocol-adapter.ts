import { MethodKind, type ServiceType } from "@bufbuild/protobuf"
import { connectNodeAdapter } from "@connectrpc/connect-node"
import {
  GetCapabilitiesResponse,
  LoadMcpServersResponse,
  PingResponse,
  UpdateEnvironmentVariablesResponse,
} from "../proto/generated/agent/v1/control_service_pb.ts"
import { ControlService } from "../proto/generated/agent/v1/control_service_connect.ts"
import {
  ExecClientControlMessage,
  ExecClientMessage,
  ExecClientStreamClose,
  ExecClientThrow,
  type ExecServerMessage,
} from "../proto/generated/agent/v1/exec_pb.ts"
import { ExecService } from "../proto/generated/agent/v1/exec_service_connect.ts"
import { ExecStreamElement } from "../proto/generated/agent/v1/exec_service_pb.ts"
import {
  BackgroundShellSpawnError,
  BackgroundShellSpawnResult,
  BackgroundShellSpawnSuccess,
  WriteShellStdinError,
  WriteShellStdinResult,
  WriteShellStdinSuccess,
} from "../proto/generated/agent/v1/background_shell_exec_pb.ts"
import {
  ReadError,
  ReadFileNotFound,
  ReadInvalidFile,
  ReadPermissionDenied,
  ReadRejected,
  ReadResult,
  ReadSuccess,
  type ReadArgs,
} from "../proto/generated/agent/v1/read_exec_pb.ts"
import {
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
  type ShellArgs,
} from "../proto/generated/agent/v1/shell_exec_pb.ts"
import type {
  BoxBackgroundShellResult,
  BoxExecRuntime,
  BoxReadResult,
  BoxShellResult,
  BoxShellStreamEvent,
  BoxWriteShellInputResult,
} from "../../../box-exec/runtime.ts"

// Generated service descriptors widen MethodKind during reconstruction; the daemon owns these literal routes.
const BoxControlService = {
  typeName: ControlService.typeName,
  methods: {
    ping: { ...ControlService.methods.ping, kind: MethodKind.Unary },
    getCapabilities: { ...ControlService.methods.getCapabilities, kind: MethodKind.Unary },
    updateEnvironmentVariables: { ...ControlService.methods.updateEnvironmentVariables, kind: MethodKind.Unary },
    loadMcpServers: { ...ControlService.methods.loadMcpServers, kind: MethodKind.Unary },
  },
} as const satisfies ServiceType

const BoxExecService = {
  typeName: ExecService.typeName,
  methods: { exec: { ...ExecService.methods.exec, kind: MethodKind.ServerStreaming } },
} as const satisfies ServiceType

function clientElement(id: number, execId: string, message: ExecClientMessage["message"]): ExecStreamElement {
  return new ExecStreamElement({
    element: {
      case: "execClientMessage",
      value: new ExecClientMessage({ id, execId, message }),
    },
  })
}

function controlElement(id: number, message: ExecClientControlMessage["message"]): ExecStreamElement {
  return new ExecStreamElement({
    element: { case: "execClientControlMessage", value: new ExecClientControlMessage({ message }) },
  })
}

function closeElement(id: number): ExecStreamElement {
  return controlElement(id, { case: "streamClose", value: new ExecClientStreamClose({ id }) })
}

function throwElement(id: number, error: unknown, errorCode = "BOX_EXEC_DAEMON_ERROR"): ExecStreamElement {
  const normalized = error instanceof Error ? error : new Error(String(error))
  return controlElement(id, {
    case: "throw",
    value: new ExecClientThrow({ id, error: normalized.message, ...(normalized.stack == null ? {} : { stackTrace: normalized.stack }), errorCode }),
  })
}

function readResultInterop(result: BoxReadResult): ReadResult {
  switch (result.kind) {
    case "success":
      return new ReadResult({
        result: {
          case: "success",
          value: new ReadSuccess({
            path: result.path,
            output: { case: "content", value: result.content },
            totalLines: result.totalLines,
            fileSize: result.fileSize,
            truncated: result.truncated,
            rangeApplied: result.rangeApplied,
          }),
        },
      })
    case "invalid-file":
      return new ReadResult({ result: { case: "invalidFile", value: new ReadInvalidFile({ path: result.path, reason: result.reason }) } })
    case "rejected":
      return new ReadResult({ result: { case: "rejected", value: new ReadRejected({ path: result.path, reason: result.reason }) } })
    case "file-not-found":
      return new ReadResult({ result: { case: "fileNotFound", value: new ReadFileNotFound({ path: result.path }) } })
    case "permission-denied":
      return new ReadResult({ result: { case: "permissionDenied", value: new ReadPermissionDenied({ path: result.path }) } })
    case "error":
      return new ReadResult({ result: { case: "error", value: new ReadError({ path: result.path, error: result.error }) } })
  }
}

function shellResultInterop(result: BoxShellResult): ShellResult {
  switch (result.kind) {
    case "spawn-error":
      return new ShellResult({ result: { case: "spawnError", value: new ShellSpawnError({ command: result.command, workingDirectory: result.workingDirectory, error: result.error }) } })
    case "timeout":
      return new ShellResult({ result: { case: "timeout", value: new ShellTimeout({ command: result.command, workingDirectory: result.workingDirectory, timeoutMs: result.timeoutMs }) } })
    case "success":
    case "failure": {
      const shared = {
        command: result.command,
        workingDirectory: result.workingDirectory,
        exitCode: result.exitCode,
        signal: result.signal,
        stdout: result.stdout,
        stderr: result.stderr,
        executionTime: result.executionTime,
        interleavedOutput: result.interleavedOutput,
        localExecutionTimeMs: result.localExecutionTimeMs,
      }
      return result.kind === "success"
        ? new ShellResult({ result: { case: "success", value: new ShellSuccess(shared) } })
        : new ShellResult({ result: { case: "failure", value: new ShellFailure({ ...shared, aborted: result.aborted ?? false }) } })
    }
  }
}

function streamEventInterop(event: BoxShellStreamEvent): ShellStream {
  switch (event.kind) {
    case "start":
      return new ShellStream({ event: { case: "start", value: new ShellStreamStart() } })
    case "stdout":
      return new ShellStream({ event: { case: "stdout", value: new ShellStreamStdout({ data: event.data }) } })
    case "stderr":
      return new ShellStream({ event: { case: "stderr", value: new ShellStreamStderr({ data: event.data }) } })
    case "exit":
      return new ShellStream({ event: { case: "exit", value: new ShellStreamExit({
        code: event.code,
        cwd: event.cwd,
        aborted: event.aborted,
        localExecutionTimeMs: event.localExecutionTimeMs,
      }) } })
  }
}

function backgroundSpawnResultInterop(result: BoxBackgroundShellResult): BackgroundShellSpawnResult {
  return result.kind === "success"
    ? new BackgroundShellSpawnResult({
        result: { case: "success", value: new BackgroundShellSpawnSuccess({
          shellId: result.shellId,
          command: result.command,
          workingDirectory: result.workingDirectory,
          ...(result.pid === undefined ? {} : { pid: result.pid }),
        }) },
      })
    : new BackgroundShellSpawnResult({
        result: { case: "error", value: new BackgroundShellSpawnError({
          command: result.command,
          workingDirectory: result.workingDirectory,
          error: result.error,
        }) },
      })
}

function writeShellInputResultInterop(result: BoxWriteShellInputResult): WriteShellStdinResult {
  return result.kind === "success"
    ? new WriteShellStdinResult({ result: { case: "success", value: new WriteShellStdinSuccess({
        shellId: result.shellId,
        terminalFileLengthBeforeInputWritten: result.terminalFileLengthBeforeInputWritten,
      }) } })
    : new WriteShellStdinResult({ result: { case: "error", value: new WriteShellStdinError({ error: result.error }) } })
}

async function* dispatchBoxExecCall(runtime: BoxExecRuntime, call: ExecServerMessage, abortSignal: AbortSignal): AsyncGenerator<ExecStreamElement> {
  try {
    switch (call.message.case) {
      case "readArgs":
      case "redactedReadArgs": {
        const input = call.message.value as ReadArgs
        const result = readResultInterop(await runtime.readFileAttrs({
          path: input.path,
          ...(input.encodingHint === undefined ? {} : { encodingHint: input.encodingHint }),
          ...(input.offset === undefined ? {} : { offset: input.offset }),
          ...(input.limit === undefined ? {} : { limit: input.limit }),
        }))
        const responseCase = call.message.case === "readArgs" ? "readResult" : "redactedReadResult"
        yield clientElement(call.id, call.execId, { case: responseCase, value: result } as ExecClientMessage["message"])
        break
      }
      case "shellArgs":
      case "miniSweAgentBashArgs": {
        const input = call.message.value as ShellArgs
        const result = shellResultInterop(await runtime.runCommand({
          command: input.command,
          workingDirectory: input.workingDirectory,
          timeout: input.timeout,
        }, abortSignal))
        const responseCase = call.message.case === "shellArgs" ? "shellResult" : "miniSweAgentBashResult"
        yield clientElement(call.id, call.execId, { case: responseCase, value: result } as ExecClientMessage["message"])
        break
      }
      case "shellStreamArgs": {
        const input = call.message.value as ShellArgs
        const request = { command: input.command, workingDirectory: input.workingDirectory, timeout: input.timeout }
        for await (const event of runtime.streamCommand(request, abortSignal)) {
          yield clientElement(call.id, call.execId, { case: "shellStream", value: streamEventInterop(event) })
        }
        break
      }
      case "backgroundShellSpawnArgs": {
        const input = call.message.value as { readonly command: string; readonly workingDirectory: string }
        const result = backgroundSpawnResultInterop(await runtime.startBackgroundShell(input))
        yield clientElement(call.id, call.execId, { case: "backgroundShellSpawnResult", value: result })
        break
      }
      case "writeShellStdinArgs": {
        const input = call.message.value as { readonly shellId: number; readonly chars: string }
        const result = writeShellInputResultInterop(await runtime.writeShellInput(input))
        yield clientElement(call.id, call.execId, { case: "writeShellStdinResult", value: result })
        break
      }
      default:
        yield throwElement(call.id, `Unsupported ExecServerMessage case: ${call.message.case ?? "unset"}`, "BOX_EXEC_UNSUPPORTED")
    }
  } catch (error) {
    yield throwElement(call.id, error)
  } finally {
    yield closeElement(call.id)
  }
}

/** Creates the Connect handler that adapts the daemon's Slate runtime to the counterpart control and exec services. */
export function createBoxExecProtocolHandler(runtime: BoxExecRuntime) {
  return connectNodeAdapter({
    routes(router) {
      router.service(BoxControlService, {
        ping: async () => new PingResponse(),
        getCapabilities: async () => new GetCapabilitiesResponse({ computerUseSupported: false, installPluginArtifactSupported: false }),
        updateEnvironmentVariables: async call => new UpdateEnvironmentVariablesResponse(runtime.applyEnvPatch({
          env: call.env,
          replace: call.replace,
        })),
        loadMcpServers: async () => new LoadMcpServersResponse(),
      })
      router.service(BoxExecService, { exec: (call, context) => dispatchBoxExecCall(runtime, call, context.signal) })
    },
  })
}
