// @ts-nocheck -- generated runtime: redaction changes a field's type structurally, so the
// declaration pass for these modules is a separate mechanical step.
//
// @generated from this repository's schema and redaction annotations. Do not edit.
//
// Regenerate with `pnpm --filter @slate/work-host redaction:generate`.
// Sensitive fields arrive as RedactedString/RedactedBytes; `fromRedacted*` asks for a purpose.
import { DataClassification } from "../../../../../../packages/redaction/classification.ts";
import { createRedactedString } from "../../../../../../packages/redaction/create.ts";
import { SendFinalSummaryArgs, SendFinalSummaryError, SendFinalSummaryResult, SendFinalSummarySuccess, SendFinalSummaryToolCall } from "../../../../proto/generated/agent/v1/send_final_summary_tool_pb.ts";

function toRedactedSendFinalSummaryArgs(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    finalSummary: msg.finalSummary !== void 0 ? createRedactedString(msg.finalSummary, DataClassification.CODE, "final_summary", privacyMode) : void 0,
  };
}

function fromRedactedSendFinalSummaryArgs(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new SendFinalSummaryArgs({
    finalSummary: msg.finalSummary?.unwrap(purpose, { redactUnallowedFieldsInsteadOfThrowing, enforcing }),
  });
}

function toRedactedSendFinalSummaryError(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    error: createRedactedString(msg.error, DataClassification.CODE, "error", privacyMode),
  };
}

function fromRedactedSendFinalSummaryError(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new SendFinalSummaryError({
    error: msg.error.unwrap(purpose, { redactUnallowedFieldsInsteadOfThrowing, enforcing }),
  });
}

function toRedactedSendFinalSummaryResult_result(oneof, privacyMode) {
  if (oneof === void 0) {
    return { case: void 0, value: void 0 };
  }
  switch (oneof.case) {
    case "success":
      return { case: "success", value: toRedactedSendFinalSummarySuccess(oneof.value, privacyMode) };
    case "error":
      return { case: "error", value: toRedactedSendFinalSummaryError(oneof.value, privacyMode) };
    default:
      return { case: void 0, value: void 0 };
  }
}

function fromRedactedSendFinalSummaryResult_result(oneof, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  if (oneof === void 0) {
    return { case: void 0, value: void 0 };
  }
  switch (oneof.case) {
    case "success":
      return { case: "success", value: fromRedactedSendFinalSummarySuccess(oneof.value, purpose, opts) };
    case "error":
      return { case: "error", value: fromRedactedSendFinalSummaryError(oneof.value, purpose, opts) };
    default:
      return { case: void 0, value: void 0 };
  }
}

function toRedactedSendFinalSummaryResult(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    result: toRedactedSendFinalSummaryResult_result(msg.result, privacyMode),
  };
}

function fromRedactedSendFinalSummaryResult(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new SendFinalSummaryResult({
    result: fromRedactedSendFinalSummaryResult_result(msg.result, purpose, opts),
  });
}

function toRedactedSendFinalSummarySuccess(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    finalSummary: createRedactedString(msg.finalSummary, DataClassification.CODE, "final_summary", privacyMode),
  };
}

function fromRedactedSendFinalSummarySuccess(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new SendFinalSummarySuccess({
    finalSummary: msg.finalSummary.unwrap(purpose, { redactUnallowedFieldsInsteadOfThrowing, enforcing }),
  });
}

function toRedactedSendFinalSummaryToolCall(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    args: msg.args !== void 0 ? toRedactedSendFinalSummaryArgs(msg.args, privacyMode) : void 0,
    result: msg.result !== void 0 ? toRedactedSendFinalSummaryResult(msg.result, privacyMode) : void 0,
  };
}

function fromRedactedSendFinalSummaryToolCall(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new SendFinalSummaryToolCall({
    args: msg.args !== void 0 ? fromRedactedSendFinalSummaryArgs(msg.args, purpose, opts) : void 0,
    result: msg.result !== void 0 ? fromRedactedSendFinalSummaryResult(msg.result, purpose, opts) : void 0,
  });
}

export {
  toRedactedSendFinalSummaryArgs,
  fromRedactedSendFinalSummaryArgs,
  toRedactedSendFinalSummaryError,
  fromRedactedSendFinalSummaryError,
  toRedactedSendFinalSummaryResult,
  fromRedactedSendFinalSummaryResult,
  toRedactedSendFinalSummaryResult_result,
  fromRedactedSendFinalSummaryResult_result,
  toRedactedSendFinalSummarySuccess,
  fromRedactedSendFinalSummarySuccess,
  toRedactedSendFinalSummaryToolCall,
  fromRedactedSendFinalSummaryToolCall,
};
