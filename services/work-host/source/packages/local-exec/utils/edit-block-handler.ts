/**
 * What a blocked command reports.
 *
 * A command can be refused for several reasons, and the model reads a different result for each: a refusal by the user
 * carries what they said, an administrator's rule carries the rule, and everything else is the plain statement that the
 * command is not allowed. A command blocked by the permissions configuration of a read-only session is reported as a
 * permission denial rather than as a rejection, because it is not something the user could approve.
 */
import { formatAdminCommandDenylistBlockReason } from "../services/admin-command-denylist.ts";

export type ShellBlockReason =
  | { readonly type: "userDeclined"; readonly detail: string }
  | { readonly type: "unsafeWorkingDirectory"; readonly message: string }
  | { readonly type: "administratorCommandRule"; readonly pattern: string }
  | {
      readonly type:
        | "approvalRequired"
        | "ignorePolicy"
        | "administratorPolicy"
        | "permissionConfiguration"
        | "managedInstructionFiles";
      readonly isReadOnly?: boolean;
    };

export function shellBlockReasonMessage(reason: ShellBlockReason): string {
  switch (reason.type) {
    case "userDeclined":
      return reason.detail;
    case "unsafeWorkingDirectory":
      return reason.message;
    case "administratorCommandRule":
      return formatAdminCommandDenylistBlockReason(reason.pattern);
    case "approvalRequired":
    case "ignorePolicy":
    case "administratorPolicy":
    case "permissionConfiguration":
    case "managedInstructionFiles":
      return "Command is not allowed";
    default: {
      const _exhaustive: never = reason;
      return `Command is not allowed (${JSON.stringify(_exhaustive)})`;
    }
  }
}
