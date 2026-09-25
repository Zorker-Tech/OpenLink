// @ts-nocheck -- generated runtime: redaction changes a field's type structurally, so the
// declaration pass for these modules is a separate mechanical step.
//
// @generated from this repository's schema and redaction annotations. Do not edit.
//
// Regenerate with `pnpm --filter @slate/work-host redaction:generate`.
// Sensitive fields arrive as RedactedString/RedactedBytes; `fromRedacted*` asks for a purpose.
import { LsArgs, LsResult } from "../../../../proto/generated/agent/v1/ls_exec_pb.ts";
import { LsToolCall } from "../../../../proto/generated/agent/v1/ls_tool_pb.ts";
import { fromRedactedLsArgs, fromRedactedLsResult, toRedactedLsArgs, toRedactedLsResult } from "./ls_exec_redacted.ts";

function toRedactedLsToolCall(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    args: msg.args !== void 0 ? toRedactedLsArgs(msg.args, privacyMode) : void 0,
    result: msg.result !== void 0 ? toRedactedLsResult(msg.result, privacyMode) : void 0,
  };
}

function fromRedactedLsToolCall(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new LsToolCall({
    args: msg.args !== void 0 ? fromRedactedLsArgs(msg.args, purpose, opts) : void 0,
    result: msg.result !== void 0 ? fromRedactedLsResult(msg.result, purpose, opts) : void 0,
  });
}

export {
  toRedactedLsToolCall,
  fromRedactedLsToolCall,
};
