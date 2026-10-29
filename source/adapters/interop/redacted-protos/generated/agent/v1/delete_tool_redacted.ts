// @ts-nocheck -- generated runtime: redaction changes a field's type structurally, so the
// declaration pass for these modules is a separate mechanical step.
//
// @generated from this repository's schema and redaction annotations. Do not edit.
//
// Regenerate with `pnpm --filter @slate/work-host redaction:generate`.
// Sensitive fields arrive as RedactedString/RedactedBytes; `fromRedacted*` asks for a purpose.
import { DeleteArgs, DeleteResult } from "../../../../proto/generated/agent/v1/delete_exec_pb.ts";
import { DeleteToolCall } from "../../../../proto/generated/agent/v1/delete_tool_pb.ts";
import { fromRedactedDeleteArgs, fromRedactedDeleteResult, toRedactedDeleteArgs, toRedactedDeleteResult } from "./delete_exec_redacted.ts";

function toRedactedDeleteToolCall(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    args: msg.args !== void 0 ? toRedactedDeleteArgs(msg.args, privacyMode) : void 0,
    result: msg.result !== void 0 ? toRedactedDeleteResult(msg.result, privacyMode) : void 0,
  };
}

function fromRedactedDeleteToolCall(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new DeleteToolCall({
    args: msg.args !== void 0 ? fromRedactedDeleteArgs(msg.args, purpose, opts) : void 0,
    result: msg.result !== void 0 ? fromRedactedDeleteResult(msg.result, purpose, opts) : void 0,
  });
}

export {
  toRedactedDeleteToolCall,
  fromRedactedDeleteToolCall,
};
