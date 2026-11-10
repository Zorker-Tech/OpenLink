/** Slate-native NDJSON execution endpoint for the box daemon. */
import type { IncomingMessage, ServerResponse } from "node:http";

import type { BoxExecRuntime } from "./runtime.ts";
import type { BoxShellResult } from "./runtime.ts";
import {
  SLATE_BOX_EXEC_PATH,
  SLATE_BOX_EXEC_PROTOCOL_HEADER,
  SLATE_BOX_EXEC_PROTOCOL_VERSION,
  SLATE_BOX_EXEC_SCHEMA,
  parseBoxExecRequest,
  type BoxExecResponse,
} from "../shared/box-exec-protocol.ts";
import { readJsonBody } from "./control-http.ts";

type WireShellResult = Extract<BoxExecResponse, { readonly kind: "shell.run" }>["result"];

function shellRunResultForWire(result: BoxShellResult): WireShellResult {
  switch (result.kind) {
    case "spawn-error":
      return {
        kind: "spawn-error",
        command: result.command,
        workingDirectory: result.workingDirectory,
        error: result.error,
      };
    case "timeout":
      return {
        kind: "timeout",
        command: result.command,
        workingDirectory: result.workingDirectory,
        timeoutMs: result.timeoutMs,
      };
    case "success":
      return {
        kind: "success",
        command: result.command,
        workingDirectory: result.workingDirectory,
        exitCode: result.exitCode,
        signal: result.signal,
        stdout: result.stdout,
        stderr: result.stderr,
        executionTime: result.executionTime,
        localExecutionTimeMs: result.localExecutionTimeMs,
        interleavedOutput: result.interleavedOutput,
      };
    case "failure":
      return {
        kind: "failure",
        command: result.command,
        workingDirectory: result.workingDirectory,
        exitCode: result.exitCode,
        signal: result.signal,
        stdout: result.stdout,
        stderr: result.stderr,
        executionTime: result.executionTime,
        localExecutionTimeMs: result.localExecutionTimeMs,
        interleavedOutput: result.interleavedOutput,
        aborted: result.aborted ?? false,
      };
  }
}

function writeLine(response: ServerResponse, value: BoxExecResponse): void {
  if (response.destroyed || response.writableEnded) return;
  response.write(JSON.stringify(value) + "\n");
}

function control(id: number, error?: { readonly message: string; readonly errorCode?: string }): BoxExecResponse {
  return {
    schema: SLATE_BOX_EXEC_SCHEMA,
    id,
    kind: "control",
    control: error === undefined
      ? { kind: "stream.close" }
      : {
          kind: "throw",
          error: error.message,
          ...(error.errorCode === undefined ? {} : { errorCode: error.errorCode }),
        },
  };
}

export async function handleSlateBoxExecHttp(
  runtime: BoxExecRuntime,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<boolean> {
  const pathname = new URL(request.url ?? "/", "http://slate-box.invalid").pathname;
  if (pathname !== SLATE_BOX_EXEC_PATH) return false;
  if (request.method !== "POST") {
    response.writeHead(405, { "content-type": "text/plain; charset=utf-8" });
    response.end("box exec endpoint requires POST");
    return true;
  }

  response.writeHead(200, {
    "cache-control": "no-store",
    "content-type": "application/x-ndjson; charset=utf-8",
    [SLATE_BOX_EXEC_PROTOCOL_HEADER]: String(SLATE_BOX_EXEC_PROTOCOL_VERSION),
  });
  const abortController = new AbortController();
  response.once("close", () => {
    if (!response.writableEnded) abortController.abort();
  });

  let id = 0;
  try {
    const call = parseBoxExecRequest(await readJsonBody(request));
    id = call.id;
    switch (call.op) {
      case "workspace.read": {
        const result = await runtime.readFileAttrs({
          path: call.path,
          ...(call.encodingHint === undefined ? {} : { encodingHint: call.encodingHint }),
          ...(call.offset === undefined ? {} : { offset: call.offset }),
          ...(call.limit === undefined ? {} : { limit: call.limit }),
        });
        writeLine(response, {
          schema: SLATE_BOX_EXEC_SCHEMA,
          id: call.id,
          kind: "workspace.read",
          redacted: call.redacted,
          result: result.kind === "success" ? { ...result, fileSize: result.fileSize.toString() } : result,
        });
        break;
      }
      case "shell.run": {
        const result = await runtime.runCommand({
          command: call.command,
          workingDirectory: call.workingDirectory,
          timeout: call.timeout,
        }, abortController.signal);
        writeLine(response, {
          schema: SLATE_BOX_EXEC_SCHEMA,
          id: call.id,
          kind: "shell.run",
          variant: call.variant,
          result: shellRunResultForWire(result),
        });
        break;
      }
      case "shell.stream":
        for await (const event of runtime.streamCommand({
          command: call.command,
          workingDirectory: call.workingDirectory,
          timeout: call.timeout,
        }, abortController.signal)) {
          writeLine(response, {
            schema: SLATE_BOX_EXEC_SCHEMA,
            id: call.id,
            kind: "shell.stream",
            event,
          });
        }
        break;
      case "shell.background.spawn": {
        const result = await runtime.startBackgroundShell({
          command: call.command,
          workingDirectory: call.workingDirectory,
        });
        writeLine(response, {
          schema: SLATE_BOX_EXEC_SCHEMA,
          id: call.id,
          kind: "shell.background.spawn",
          result,
        });
        break;
      }
      case "shell.stdin.write": {
        const result = await runtime.writeShellInput({ shellId: call.shellId, chars: call.chars });
        writeLine(response, {
          schema: SLATE_BOX_EXEC_SCHEMA,
          id: call.id,
          kind: "shell.stdin.write",
          result,
        });
        break;
      }
      case "unsupported":
        writeLine(response, control(call.id, {
          message: `Unsupported Slate box operation: ${call.sourceOperation}`,
          errorCode: "BOX_EXEC_UNSUPPORTED",
        }));
        break;
    }
    writeLine(response, control(call.id));
  } catch (error) {
    writeLine(response, control(id, {
      message: error instanceof Error ? error.message : String(error),
      errorCode: "BOX_EXEC_DAEMON_ERROR",
    }));
    writeLine(response, control(id));
  } finally {
    if (!response.writableEnded) response.end();
  }
  return true;
}
