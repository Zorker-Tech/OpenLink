// @ts-nocheck -- generated runtime: redaction changes a field's type structurally, so the
// declaration pass for these modules is a separate mechanical step.
//
// @generated from this repository's schema and redaction annotations. Do not edit.
//
// Regenerate with `pnpm --filter @slate/work-host redaction:generate`.
// Sensitive fields arrive as RedactedString/RedactedBytes; `fromRedacted*` asks for a purpose.
import { RecordScreenArgs, RecordScreenResult } from "../../../../proto/generated/agent/v1/record_screen_exec_pb.ts";
import { RecordScreenToolCall } from "../../../../proto/generated/agent/v1/record_screen_tool_pb.ts";
import { fromRedactedRecordScreenArgs, fromRedactedRecordScreenResult, toRedactedRecordScreenArgs, toRedactedRecordScreenResult } from "./record_screen_exec_redacted.ts";

function toRedactedRecordScreenToolCall(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    args: msg.args !== void 0 ? toRedactedRecordScreenArgs(msg.args, privacyMode) : void 0,
    result: msg.result !== void 0 ? toRedactedRecordScreenResult(msg.result, privacyMode) : void 0,
  };
}

function fromRedactedRecordScreenToolCall(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new RecordScreenToolCall({
    args: msg.args !== void 0 ? fromRedactedRecordScreenArgs(msg.args, purpose, opts) : void 0,
    result: msg.result !== void 0 ? fromRedactedRecordScreenResult(msg.result, purpose, opts) : void 0,
  });
}

export {
  toRedactedRecordScreenToolCall,
  fromRedactedRecordScreenToolCall,
};
