import {
  ShellPermissionDenied,
  ShellRejected,
  type ShellResult,
} from "../proto/generated/agent/v1/shell_exec_pb.ts"
import { shellBlockReasonMessage, type ShellBlockReason } from "../../../packages/local-exec/utils/edit-block-handler.ts"

/** Encode Slate's shell refusal decision in the counterpart executor result format. */
export function shellCommandBlockResultForInterop(
  command: string,
  workingDirectory: string,
  reason: ShellBlockReason,
): ShellResult["result"] {
  if (reason.type === "permissionConfiguration" && (reason.isReadOnly ?? false)) {
    return {
      case: "permissionDenied",
      value: new ShellPermissionDenied({
        command,
        workingDirectory,
        error: "Command blocked by permissions configuration",
        isReadonly: true,
      }),
    }
  }

  return {
    case: "rejected",
    value: new ShellRejected({
      command,
      workingDirectory,
      reason: shellBlockReasonMessage(reason),
    }),
  }
}
