// @ts-nocheck -- generated runtime: redaction changes a field's type structurally, so the
// declaration pass for these modules is a separate mechanical step.
//
// @generated from this repository's schema and redaction annotations. Do not edit.
//
// Regenerate with `pnpm --filter @slate/work-host redaction:generate`.
// Sensitive fields arrive as RedactedString/RedactedBytes; `fromRedacted*` asks for a purpose.
import { DataClassification } from "../../../../../../packages/redaction/classification.ts";
import { createRedactedString } from "../../../../../../packages/redaction/create.ts";
import { UpdatePrCodeTourArgs, UpdatePrCodeTourError, UpdatePrCodeTourResult, UpdatePrCodeTourSuccess, UpdatePrCodeTourToolCall } from "../../../../proto/generated/agent/v1/update_pr_code_tour_tool_pb.ts";

function toRedactedUpdatePrCodeTourArgs(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    feedback: createRedactedString(msg.feedback, DataClassification.CODE, "feedback", privacyMode),
    toolCallId: msg.toolCallId,
  };
}

function fromRedactedUpdatePrCodeTourArgs(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new UpdatePrCodeTourArgs({
    feedback: msg.feedback.unwrap(purpose, { redactUnallowedFieldsInsteadOfThrowing, enforcing }),
    toolCallId: msg.toolCallId,
  });
}

function toRedactedUpdatePrCodeTourError(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    error: createRedactedString(msg.error, DataClassification.CODE, "error", privacyMode),
  };
}

function fromRedactedUpdatePrCodeTourError(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new UpdatePrCodeTourError({
    error: msg.error.unwrap(purpose, { redactUnallowedFieldsInsteadOfThrowing, enforcing }),
  });
}

function toRedactedUpdatePrCodeTourResult_result(oneof, privacyMode) {
  if (oneof === void 0) {
    return { case: void 0, value: void 0 };
  }
  switch (oneof.case) {
    case "success":
      return { case: "success", value: toRedactedUpdatePrCodeTourSuccess(oneof.value, privacyMode) };
    case "error":
      return { case: "error", value: toRedactedUpdatePrCodeTourError(oneof.value, privacyMode) };
    default:
      return { case: void 0, value: void 0 };
  }
}

function fromRedactedUpdatePrCodeTourResult_result(oneof, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  if (oneof === void 0) {
    return { case: void 0, value: void 0 };
  }
  switch (oneof.case) {
    case "success":
      return { case: "success", value: fromRedactedUpdatePrCodeTourSuccess(oneof.value, purpose, opts) };
    case "error":
      return { case: "error", value: fromRedactedUpdatePrCodeTourError(oneof.value, purpose, opts) };
    default:
      return { case: void 0, value: void 0 };
  }
}

function toRedactedUpdatePrCodeTourResult(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    result: toRedactedUpdatePrCodeTourResult_result(msg.result, privacyMode),
  };
}

function fromRedactedUpdatePrCodeTourResult(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new UpdatePrCodeTourResult({
    result: fromRedactedUpdatePrCodeTourResult_result(msg.result, purpose, opts),
  });
}

function toRedactedUpdatePrCodeTourSuccess(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    revisionId: msg.revisionId,
    message: createRedactedString(msg.message, DataClassification.CODE, "message", privacyMode),
    executionMode: msg.executionMode,
  };
}

function fromRedactedUpdatePrCodeTourSuccess(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new UpdatePrCodeTourSuccess({
    revisionId: msg.revisionId,
    message: msg.message.unwrap(purpose, { redactUnallowedFieldsInsteadOfThrowing, enforcing }),
    executionMode: msg.executionMode,
  });
}

function toRedactedUpdatePrCodeTourToolCall(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    args: msg.args !== void 0 ? toRedactedUpdatePrCodeTourArgs(msg.args, privacyMode) : void 0,
    result: msg.result !== void 0 ? toRedactedUpdatePrCodeTourResult(msg.result, privacyMode) : void 0,
  };
}

function fromRedactedUpdatePrCodeTourToolCall(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new UpdatePrCodeTourToolCall({
    args: msg.args !== void 0 ? fromRedactedUpdatePrCodeTourArgs(msg.args, purpose, opts) : void 0,
    result: msg.result !== void 0 ? fromRedactedUpdatePrCodeTourResult(msg.result, purpose, opts) : void 0,
  });
}

export {
  toRedactedUpdatePrCodeTourArgs,
  fromRedactedUpdatePrCodeTourArgs,
  toRedactedUpdatePrCodeTourError,
  fromRedactedUpdatePrCodeTourError,
  toRedactedUpdatePrCodeTourResult,
  fromRedactedUpdatePrCodeTourResult,
  toRedactedUpdatePrCodeTourResult_result,
  fromRedactedUpdatePrCodeTourResult_result,
  toRedactedUpdatePrCodeTourSuccess,
  fromRedactedUpdatePrCodeTourSuccess,
  toRedactedUpdatePrCodeTourToolCall,
  fromRedactedUpdatePrCodeTourToolCall,
};
