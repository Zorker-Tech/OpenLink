// @ts-nocheck -- generated runtime: redaction changes a field's type structurally, so the
// declaration pass for these modules is a separate mechanical step.
//
// @generated from this repository's schema and redaction annotations. Do not edit.
//
// Regenerate with `pnpm --filter @slate/work-host redaction:generate`.
// Sensitive fields arrive as RedactedString/RedactedBytes; `fromRedacted*` asks for a purpose.
import { WriteShellStdinArgs, WriteShellStdinResult } from "../../../../proto/generated/agent/v1/background_shell_exec_pb.ts";
import { WriteShellStdinToolCall } from "../../../../proto/generated/agent/v1/write_shell_stdin_tool_pb.ts";
import { fromRedactedWriteShellStdinArgs, fromRedactedWriteShellStdinResult, toRedactedWriteShellStdinArgs, toRedactedWriteShellStdinResult } from "./background_shell_exec_redacted.ts";

function toRedactedWriteShellStdinToolCall(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    args: msg.args !== void 0 ? toRedactedWriteShellStdinArgs(msg.args, privacyMode) : void 0,
    result: msg.result !== void 0 ? toRedactedWriteShellStdinResult(msg.result, privacyMode) : void 0,
  };
}

function fromRedactedWriteShellStdinToolCall(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new WriteShellStdinToolCall({
    args: msg.args !== void 0 ? fromRedactedWriteShellStdinArgs(msg.args, purpose, opts) : void 0,
    result: msg.result !== void 0 ? fromRedactedWriteShellStdinResult(msg.result, purpose, opts) : void 0,
  });
}

export {
  toRedactedWriteShellStdinToolCall,
  fromRedactedWriteShellStdinToolCall,
};
