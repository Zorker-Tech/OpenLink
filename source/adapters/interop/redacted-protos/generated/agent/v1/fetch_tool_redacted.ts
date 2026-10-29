// @ts-nocheck -- generated runtime: redaction changes a field's type structurally, so the
// declaration pass for these modules is a separate mechanical step.
//
// @generated from this repository's schema and redaction annotations. Do not edit.
//
// Regenerate with `pnpm --filter @slate/work-host redaction:generate`.
// Sensitive fields arrive as RedactedString/RedactedBytes; `fromRedacted*` asks for a purpose.
import { FetchArgs, FetchResult } from "../../../../proto/generated/agent/v1/fetch_exec_pb.ts";
import { FetchToolCall } from "../../../../proto/generated/agent/v1/fetch_tool_pb.ts";
import { fromRedactedFetchArgs, fromRedactedFetchResult, toRedactedFetchArgs, toRedactedFetchResult } from "./fetch_exec_redacted.ts";

function toRedactedFetchToolCall(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    args: msg.args !== void 0 ? toRedactedFetchArgs(msg.args, privacyMode) : void 0,
    result: msg.result !== void 0 ? toRedactedFetchResult(msg.result, privacyMode) : void 0,
  };
}

function fromRedactedFetchToolCall(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new FetchToolCall({
    args: msg.args !== void 0 ? fromRedactedFetchArgs(msg.args, purpose, opts) : void 0,
    result: msg.result !== void 0 ? fromRedactedFetchResult(msg.result, purpose, opts) : void 0,
  });
}

export {
  toRedactedFetchToolCall,
  fromRedactedFetchToolCall,
};
