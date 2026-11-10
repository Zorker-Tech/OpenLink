// @ts-nocheck -- generated runtime: redaction changes a field's type structurally, so the
// declaration pass for these modules is a separate mechanical step.
//
// @generated from this repository's schema and redaction annotations. Do not edit.
//
// Regenerate with `pnpm --filter @slate/work-host redaction:generate`.
// Sensitive fields arrive as RedactedString/RedactedBytes; `fromRedacted*` asks for a purpose.
import { DataClassification } from "../../../../../../packages/redaction/classification.ts";
import { createRedactedString } from "../../../../../../packages/redaction/create.ts";
import { PiBashToolArgs, PiBashToolCall, PiBashToolError, PiBashToolResult, PiBashToolSuccess } from "../../../../proto/generated/agent/v1/pi_bash_tool_pb.ts";
import { PiTruncation } from "../../../../proto/generated/agent/v1/pi_common_pb.ts";
import { fromRedactedPiTruncation, toRedactedPiTruncation } from "./pi_common_redacted.ts";

function toRedactedPiBashToolArgs(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    command: createRedactedString(msg.command, DataClassification.CODE, "command", privacyMode),
    timeout: msg.timeout,
  };
}

function fromRedactedPiBashToolArgs(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new PiBashToolArgs({
    command: msg.command.unwrap(purpose, { redactUnallowedFieldsInsteadOfThrowing, enforcing }),
    timeout: msg.timeout,
  });
}

function toRedactedPiBashToolCall(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    args: msg.args !== void 0 ? toRedactedPiBashToolArgs(msg.args, privacyMode) : void 0,
    result: msg.result !== void 0 ? toRedactedPiBashToolResult(msg.result, privacyMode) : void 0,
  };
}

function fromRedactedPiBashToolCall(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new PiBashToolCall({
    args: msg.args !== void 0 ? fromRedactedPiBashToolArgs(msg.args, purpose, opts) : void 0,
    result: msg.result !== void 0 ? fromRedactedPiBashToolResult(msg.result, purpose, opts) : void 0,
  });
}

function toRedactedPiBashToolError(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    error: createRedactedString(msg.error, DataClassification.CODE, "error", privacyMode),
    truncation: msg.truncation !== void 0 ? toRedactedPiTruncation(msg.truncation, privacyMode) : void 0,
    fullOutputPath: msg.fullOutputPath !== void 0 ? createRedactedString(msg.fullOutputPath, DataClassification.PATH, "full_output_path", privacyMode) : void 0,
  };
}

function fromRedactedPiBashToolError(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new PiBashToolError({
    error: msg.error.unwrap(purpose, { redactUnallowedFieldsInsteadOfThrowing, enforcing }),
    truncation: msg.truncation !== void 0 ? fromRedactedPiTruncation(msg.truncation, purpose, opts) : void 0,
    fullOutputPath: msg.fullOutputPath?.unwrap(purpose, { redactUnallowedFieldsInsteadOfThrowing, enforcing }),
  });
}

function toRedactedPiBashToolResult_result(oneof, privacyMode) {
  if (oneof === void 0) {
    return { case: void 0, value: void 0 };
  }
  switch (oneof.case) {
    case "success":
      return { case: "success", value: toRedactedPiBashToolSuccess(oneof.value, privacyMode) };
    case "error":
      return { case: "error", value: toRedactedPiBashToolError(oneof.value, privacyMode) };
    default:
      return { case: void 0, value: void 0 };
  }
}

function fromRedactedPiBashToolResult_result(oneof, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  if (oneof === void 0) {
    return { case: void 0, value: void 0 };
  }
  switch (oneof.case) {
    case "success":
      return { case: "success", value: fromRedactedPiBashToolSuccess(oneof.value, purpose, opts) };
    case "error":
      return { case: "error", value: fromRedactedPiBashToolError(oneof.value, purpose, opts) };
    default:
      return { case: void 0, value: void 0 };
  }
}

function toRedactedPiBashToolResult(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    result: toRedactedPiBashToolResult_result(msg.result, privacyMode),
  };
}

function fromRedactedPiBashToolResult(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new PiBashToolResult({
    result: fromRedactedPiBashToolResult_result(msg.result, purpose, opts),
  });
}

function toRedactedPiBashToolSuccess(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    output: createRedactedString(msg.output, DataClassification.CODE, "output", privacyMode),
    truncation: msg.truncation !== void 0 ? toRedactedPiTruncation(msg.truncation, privacyMode) : void 0,
    fullOutputPath: msg.fullOutputPath !== void 0 ? createRedactedString(msg.fullOutputPath, DataClassification.PATH, "full_output_path", privacyMode) : void 0,
  };
}

function fromRedactedPiBashToolSuccess(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new PiBashToolSuccess({
    output: msg.output.unwrap(purpose, { redactUnallowedFieldsInsteadOfThrowing, enforcing }),
    truncation: msg.truncation !== void 0 ? fromRedactedPiTruncation(msg.truncation, purpose, opts) : void 0,
    fullOutputPath: msg.fullOutputPath?.unwrap(purpose, { redactUnallowedFieldsInsteadOfThrowing, enforcing }),
  });
}

export {
  toRedactedPiBashToolArgs,
  fromRedactedPiBashToolArgs,
  toRedactedPiBashToolCall,
  fromRedactedPiBashToolCall,
  toRedactedPiBashToolError,
  fromRedactedPiBashToolError,
  toRedactedPiBashToolResult,
  fromRedactedPiBashToolResult,
  toRedactedPiBashToolResult_result,
  fromRedactedPiBashToolResult_result,
  toRedactedPiBashToolSuccess,
  fromRedactedPiBashToolSuccess,
};
