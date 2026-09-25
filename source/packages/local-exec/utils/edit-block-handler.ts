/**
 * What a blocked command reports.
 *
 * A command can be refused for several reasons, and the model reads a different result for each: a refusal by the user
 * carries what they said, an administrator's rule carries the rule, and everything else is the plain statement that the
 * command is not allowed. A command blocked by the permissions configuration of a read-only session is reported as a
 * permission denial rather than as a rejection, because it is not something the user could approve.
 */
import {
  ShellPermissionDenied,
  ShellRejected,
  type ShellResult,
} from "../../proto/generated/agent/v1/shell_exec_pb.ts";
import { formatAdminCommandDenylistBlockReason } from "../services/admin-command-denylist.ts";

export type ShellBlockReason =
  | { readonly type: "userRejected"; readonly reason: string }
  | { readonly type: "unsafeResolution"; readonly message: string }
  | { readonly type: "adminCommandDenylist"; readonly pattern: string }
  | {
      readonly type:
        | "needsApproval"
        | "cursorIgnore"
        | "adminBlock"
        | "permissionsConfig"
        | "cursorFiles";
      readonly isReadonly?: boolean;
    };

export function shellBlockReasonMessage(reason: ShellBlockReason): string {
  switch (reason.type) {
    case "userRejected":
      return reason.reason;
    case "unsafeResolution":
      return reason.message;
    case "adminCommandDenylist":
      return formatAdminCommandDenylistBlockReason(reason.pattern);
    case "needsApproval":
    case "cursorIgnore":
    case "adminBlock":
    case "permissionsConfig":
    case "cursorFiles":
      return "Command is not allowed";
    default: {
      const _exhaustive: never = reason;
      return `Command is not allowed (${JSON.stringify(_exhaustive)})`;
    }
  }
}

export function shellCommandBlockResult(
  command: string,
  workingDirectory: string,
  reason: ShellBlockReason,
): ShellResult["result"] {
  if (reason.type === "permissionsConfig" && (reason.isReadonly ?? false)) {
    return {
      case: "permissionDenied",
      value: new ShellPermissionDenied({
        command,
        workingDirectory,
        error: "Command blocked by permissions configuration",
        isReadonly: true,
      }),
    };
  }
  return {
    case: "rejected",
    value: new ShellRejected({
      command,
      workingDirectory,
      reason: shellBlockReasonMessage(reason),
    }),
  };
}
