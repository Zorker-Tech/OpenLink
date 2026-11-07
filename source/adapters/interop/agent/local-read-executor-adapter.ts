/** Connects the machine-local reader to Slate's read contract and its legacy wire form. */

import type { ReadResult } from "../proto/generated/agent/v1/read_exec_pb.ts"
import type { LocalReadArgs, LocalReadOutcome } from "../../../packages/local-exec/read.ts"
import type { ReadExecutorArgs, ReadExecutorResult } from "../../../packages/agent-exec/read-operation.ts"
import { readExecutorResultToInterop } from "./read-exec-operation-adapter.ts"

export function localReadArgsFromSlate(args: ReadExecutorArgs): LocalReadArgs {
  return {
    path: args.path,
    ...(args.toolCallId === undefined ? {} : { toolCallId: args.toolCallId }),
    ...(args.offset === undefined ? {} : { offset: args.offset }),
    ...(args.limit === undefined ? {} : { limit: args.limit }),
    ...(args.encodingHint === undefined ? {} : { encodingHint: args.encodingHint }),
  }
}

export function localReadOutcomeToSlate(result: LocalReadOutcome): ReadExecutorResult {
  switch (result.kind) {
    case "success":
      return {
        kind: "success",
        path: result.path,
        output: result.output,
        totalLines: result.totalLines,
        fileSize: BigInt(result.fileSize),
        truncated: result.truncated,
        rangeApplied: result.rangeApplied,
      }
    case "invalid_file":
      return { kind: "invalid-file", path: result.path, reason: result.reason }
    case "permission_denied":
      return { kind: "permission-denied", path: result.path }
    case "not_found":
      return { kind: "not-found", path: result.path }
    case "error":
      return { kind: "error", path: result.path, error: result.error }
  }
}

export interface InteropReadRequestFields {
  readonly path: string
  readonly toolCallId?: string
  readonly offset?: number
  readonly limit?: number
  readonly encodingHint?: string
}

export function localReadArgsFromInterop(args: InteropReadRequestFields): LocalReadArgs {
  return localReadArgsFromSlate(args)
}

export function localReadOutcomeToInterop(result: LocalReadOutcome): ReadResult {
  return readExecutorResultToInterop(localReadOutcomeToSlate(result))
}
