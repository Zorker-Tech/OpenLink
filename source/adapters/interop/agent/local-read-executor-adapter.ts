/** Maps Slate's local file-read outcomes to the generated executor result envelope. */

import {
  ReadError,
  ReadFileNotFound,
  ReadInvalidFile,
  ReadPermissionDenied,
  ReadResult,
  ReadSuccess,
} from "../proto/generated/agent/v1/read_exec_pb.ts"
import type { LocalReadArgs, LocalReadOutcome } from "../../../packages/local-exec/read.ts"

export interface InteropReadRequestFields {
  readonly path: string
  readonly toolCallId?: string
  readonly offset?: number
  readonly limit?: number
  readonly encodingHint?: string
}

export function localReadArgsFromInterop(args: InteropReadRequestFields): LocalReadArgs {
  return {
    path: args.path,
    ...(args.toolCallId === undefined ? {} : { toolCallId: args.toolCallId }),
    ...(args.offset === undefined ? {} : { offset: args.offset }),
    ...(args.limit === undefined ? {} : { limit: args.limit }),
    ...(args.encodingHint === undefined ? {} : { encodingHint: args.encodingHint }),
  }
}

export function localReadOutcomeToInterop(result: LocalReadOutcome): ReadResult {
  switch (result.kind) {
    case "success":
      return new ReadResult({
        result: {
          case: "success",
          value: new ReadSuccess({
            path: result.path,
            output: result.output.kind === "text"
              ? { case: "content", value: result.output.text }
              : { case: "data", value: result.output.bytes },
            totalLines: result.totalLines,
            fileSize: BigInt(result.fileSize),
            truncated: result.truncated,
            rangeApplied: result.rangeApplied,
          }),
        },
      })
    case "invalid_file":
      return new ReadResult({ result: { case: "invalidFile", value: new ReadInvalidFile({ path: result.path, reason: result.reason }) } })
    case "permission_denied":
      return new ReadResult({ result: { case: "permissionDenied", value: new ReadPermissionDenied({ path: result.path }) } })
    case "not_found":
      return new ReadResult({ result: { case: "fileNotFound", value: new ReadFileNotFound({ path: result.path }) } })
    case "error":
      return new ReadResult({ result: { case: "error", value: new ReadError({ path: result.path, error: result.error }) } })
  }
}
