// @ts-nocheck -- generated runtime: redaction changes a field's type structurally, so the
// declaration pass for these modules is a separate mechanical step.
//
// @generated from this repository's schema and redaction annotations. Do not edit.
//
// Regenerate with `pnpm --filter @slate/work-host redaction:generate`.
// Sensitive fields arrive as RedactedString/RedactedBytes; `fromRedacted*` asks for a purpose.
import { DataClassification } from "../../../../../../packages/redaction/classification.ts";
import { createRedactedString } from "../../../../../../packages/redaction/create.ts";
import { StartGrindPlanningArgs, StartGrindPlanningError, StartGrindPlanningResult, StartGrindPlanningSuccess, StartGrindPlanningToolCall } from "../../../../proto/generated/agent/v1/start_grind_planning_tool_pb.ts";

function toRedactedStartGrindPlanningArgs(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    explanation: msg.explanation !== void 0 ? createRedactedString(msg.explanation, DataClassification.CODE, "explanation", privacyMode) : void 0,
    toolCallId: msg.toolCallId,
  };
}

function fromRedactedStartGrindPlanningArgs(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new StartGrindPlanningArgs({
    explanation: msg.explanation?.unwrap(purpose, { redactUnallowedFieldsInsteadOfThrowing, enforcing }),
    toolCallId: msg.toolCallId,
  });
}

function toRedactedStartGrindPlanningError(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    error: createRedactedString(msg.error, DataClassification.CODE, "error", privacyMode),
  };
}

function fromRedactedStartGrindPlanningError(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new StartGrindPlanningError({
    error: msg.error.unwrap(purpose, { redactUnallowedFieldsInsteadOfThrowing, enforcing }),
  });
}

function toRedactedStartGrindPlanningResult_result(oneof, privacyMode) {
  if (oneof === void 0) {
    return { case: void 0, value: void 0 };
  }
  switch (oneof.case) {
    case "success":
      return { case: "success", value: toRedactedStartGrindPlanningSuccess(oneof.value, privacyMode) };
    case "error":
      return { case: "error", value: toRedactedStartGrindPlanningError(oneof.value, privacyMode) };
    default:
      return { case: void 0, value: void 0 };
  }
}

function fromRedactedStartGrindPlanningResult_result(oneof, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  if (oneof === void 0) {
    return { case: void 0, value: void 0 };
  }
  switch (oneof.case) {
    case "success":
      return { case: "success", value: fromRedactedStartGrindPlanningSuccess(oneof.value, purpose, opts) };
    case "error":
      return { case: "error", value: fromRedactedStartGrindPlanningError(oneof.value, purpose, opts) };
    default:
      return { case: void 0, value: void 0 };
  }
}

function toRedactedStartGrindPlanningResult(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    result: toRedactedStartGrindPlanningResult_result(msg.result, privacyMode),
  };
}

function fromRedactedStartGrindPlanningResult(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new StartGrindPlanningResult({
    result: fromRedactedStartGrindPlanningResult_result(msg.result, purpose, opts),
  });
}

function toRedactedStartGrindPlanningSuccess(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
  };
}

function fromRedactedStartGrindPlanningSuccess(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new StartGrindPlanningSuccess({
  });
}

function toRedactedStartGrindPlanningToolCall(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    args: msg.args !== void 0 ? toRedactedStartGrindPlanningArgs(msg.args, privacyMode) : void 0,
    result: msg.result !== void 0 ? toRedactedStartGrindPlanningResult(msg.result, privacyMode) : void 0,
  };
}

function fromRedactedStartGrindPlanningToolCall(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new StartGrindPlanningToolCall({
    args: msg.args !== void 0 ? fromRedactedStartGrindPlanningArgs(msg.args, purpose, opts) : void 0,
    result: msg.result !== void 0 ? fromRedactedStartGrindPlanningResult(msg.result, purpose, opts) : void 0,
  });
}

export {
  toRedactedStartGrindPlanningArgs,
  fromRedactedStartGrindPlanningArgs,
  toRedactedStartGrindPlanningError,
  fromRedactedStartGrindPlanningError,
  toRedactedStartGrindPlanningResult,
  fromRedactedStartGrindPlanningResult,
  toRedactedStartGrindPlanningResult_result,
  fromRedactedStartGrindPlanningResult_result,
  toRedactedStartGrindPlanningSuccess,
  fromRedactedStartGrindPlanningSuccess,
  toRedactedStartGrindPlanningToolCall,
  fromRedactedStartGrindPlanningToolCall,
};
