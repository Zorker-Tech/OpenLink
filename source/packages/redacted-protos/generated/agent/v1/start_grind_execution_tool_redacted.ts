// @ts-nocheck -- generated runtime: redaction changes a field's type structurally, so the
// declaration pass for these modules is a separate mechanical step.
//
// @generated from this repository's schema and redaction annotations. Do not edit.
//
// Regenerate with `pnpm --filter @slate/work-host redaction:generate`.
// Sensitive fields arrive as RedactedString/RedactedBytes; `fromRedacted*` asks for a purpose.
import { DataClassification } from "../../../../redaction/classification.ts";
import { createRedactedString } from "../../../../redaction/create.ts";
import { StartGrindExecutionArgs, StartGrindExecutionError, StartGrindExecutionResult, StartGrindExecutionSuccess, StartGrindExecutionToolCall } from "../../../../proto/generated/agent/v1/start_grind_execution_tool_pb.ts";

function toRedactedStartGrindExecutionArgs(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    explanation: msg.explanation !== void 0 ? createRedactedString(msg.explanation, DataClassification.CODE, "explanation", privacyMode) : void 0,
    toolCallId: msg.toolCallId,
  };
}

function fromRedactedStartGrindExecutionArgs(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new StartGrindExecutionArgs({
    explanation: msg.explanation?.unwrap(purpose, { redactUnallowedFieldsInsteadOfThrowing, enforcing }),
    toolCallId: msg.toolCallId,
  });
}

function toRedactedStartGrindExecutionError(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    error: createRedactedString(msg.error, DataClassification.CODE, "error", privacyMode),
  };
}

function fromRedactedStartGrindExecutionError(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new StartGrindExecutionError({
    error: msg.error.unwrap(purpose, { redactUnallowedFieldsInsteadOfThrowing, enforcing }),
  });
}

function toRedactedStartGrindExecutionResult_result(oneof, privacyMode) {
  if (oneof === void 0) {
    return { case: void 0, value: void 0 };
  }
  switch (oneof.case) {
    case "success":
      return { case: "success", value: toRedactedStartGrindExecutionSuccess(oneof.value, privacyMode) };
    case "error":
      return { case: "error", value: toRedactedStartGrindExecutionError(oneof.value, privacyMode) };
    default:
      return { case: void 0, value: void 0 };
  }
}

function fromRedactedStartGrindExecutionResult_result(oneof, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  if (oneof === void 0) {
    return { case: void 0, value: void 0 };
  }
  switch (oneof.case) {
    case "success":
      return { case: "success", value: fromRedactedStartGrindExecutionSuccess(oneof.value, purpose, opts) };
    case "error":
      return { case: "error", value: fromRedactedStartGrindExecutionError(oneof.value, purpose, opts) };
    default:
      return { case: void 0, value: void 0 };
  }
}

function toRedactedStartGrindExecutionResult(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    result: toRedactedStartGrindExecutionResult_result(msg.result, privacyMode),
  };
}

function fromRedactedStartGrindExecutionResult(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new StartGrindExecutionResult({
    result: fromRedactedStartGrindExecutionResult_result(msg.result, purpose, opts),
  });
}

function toRedactedStartGrindExecutionSuccess(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
  };
}

function fromRedactedStartGrindExecutionSuccess(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new StartGrindExecutionSuccess({
  });
}

function toRedactedStartGrindExecutionToolCall(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    args: msg.args !== void 0 ? toRedactedStartGrindExecutionArgs(msg.args, privacyMode) : void 0,
    result: msg.result !== void 0 ? toRedactedStartGrindExecutionResult(msg.result, privacyMode) : void 0,
  };
}

function fromRedactedStartGrindExecutionToolCall(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new StartGrindExecutionToolCall({
    args: msg.args !== void 0 ? fromRedactedStartGrindExecutionArgs(msg.args, purpose, opts) : void 0,
    result: msg.result !== void 0 ? fromRedactedStartGrindExecutionResult(msg.result, purpose, opts) : void 0,
  });
}

export {
  toRedactedStartGrindExecutionArgs,
  fromRedactedStartGrindExecutionArgs,
  toRedactedStartGrindExecutionError,
  fromRedactedStartGrindExecutionError,
  toRedactedStartGrindExecutionResult,
  fromRedactedStartGrindExecutionResult,
  toRedactedStartGrindExecutionResult_result,
  fromRedactedStartGrindExecutionResult_result,
  toRedactedStartGrindExecutionSuccess,
  fromRedactedStartGrindExecutionSuccess,
  toRedactedStartGrindExecutionToolCall,
  fromRedactedStartGrindExecutionToolCall,
};
