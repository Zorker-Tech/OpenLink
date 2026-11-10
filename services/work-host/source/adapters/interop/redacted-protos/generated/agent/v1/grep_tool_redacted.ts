// @ts-nocheck -- generated runtime: redaction changes a field's type structurally, so the
// declaration pass for these modules is a separate mechanical step.
//
// @generated from this repository's schema and redaction annotations. Do not edit.
//
// Regenerate with `pnpm --filter @slate/work-host redaction:generate`.
// Sensitive fields arrive as RedactedString/RedactedBytes; `fromRedacted*` asks for a purpose.
import { GrepArgs, GrepResult } from "../../../../proto/generated/agent/v1/grep_exec_pb.ts";
import { GrepToolCall } from "../../../../proto/generated/agent/v1/grep_tool_pb.ts";
import { fromRedactedGrepArgs, fromRedactedGrepResult, toRedactedGrepArgs, toRedactedGrepResult } from "./grep_exec_redacted.ts";

function toRedactedGrepToolCall(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    args: msg.args !== void 0 ? toRedactedGrepArgs(msg.args, privacyMode) : void 0,
    result: msg.result !== void 0 ? toRedactedGrepResult(msg.result, privacyMode) : void 0,
  };
}

function fromRedactedGrepToolCall(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new GrepToolCall({
    args: msg.args !== void 0 ? fromRedactedGrepArgs(msg.args, purpose, opts) : void 0,
    result: msg.result !== void 0 ? fromRedactedGrepResult(msg.result, purpose, opts) : void 0,
  });
}

export {
  toRedactedGrepToolCall,
  fromRedactedGrepToolCall,
};
