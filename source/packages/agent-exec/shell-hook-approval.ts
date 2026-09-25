/**
 * Whether a shell command needs the user's approval, as decided by a hook rather than by the classifier.
 *
 * A session can require approval for shell commands through a hook, and the requirement is set once when the session is configured and read every time a command runs — so it is kept here as a small piece of state rather than threaded through the call. A requirement that forces a prompt is one of the shapes a caller can set, and reading an unset requirement answers nothing rather than defaulting to a prompt, because the default belongs to the caller that asked.
 */

import type { PartialMessage } from "@bufbuild/protobuf";

import {
  ShellHookApprovalRequirement,
  ShellHookApprovalRequirement_Kind,
} from "../proto/generated/agent/v1/shell_exec_pb.ts";

interface ShellHookApprovalArgs {
  hookApprovalRequirement?: ShellHookApprovalRequirement | undefined;
}

export function setShellHookApprovalRequirement(
  args: ShellHookApprovalArgs,
  requirement: PartialMessage<ShellHookApprovalRequirement> | undefined,
): void {
  if (requirement === undefined) {
    args.hookApprovalRequirement = undefined;
    return;
  }
  args.hookApprovalRequirement = new ShellHookApprovalRequirement(requirement);
}

export function createForcePromptHookApprovalRequirement(
  reason: string | undefined,
): ShellHookApprovalRequirement {
  return new ShellHookApprovalRequirement({
    kind: ShellHookApprovalRequirement_Kind.FORCE_PROMPT,
    reason: reason!,
  });
}

export function getShellHookApprovalRequirement(
  args: ShellHookApprovalArgs,
): ShellHookApprovalRequirement | undefined {
  return args.hookApprovalRequirement;
}
