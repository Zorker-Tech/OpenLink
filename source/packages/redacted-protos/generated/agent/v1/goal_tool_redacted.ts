// @ts-nocheck -- generated runtime: redaction changes a field's type structurally, so the
// declaration pass for these modules is a separate mechanical step.
//
// @generated from this repository's schema and redaction annotations. Do not edit.
//
// Regenerate with `pnpm --filter @slate/work-host redaction:generate`.
// Sensitive fields arrive as RedactedString/RedactedBytes; `fromRedacted*` asks for a purpose.
import { DataClassification } from "../../../../redaction/classification.ts";
import { createRedactedString } from "../../../../redaction/create.ts";
import { CreateGoalArgs, CreateGoalResult, CreateGoalSuccess, CreateGoalToolCall, GoalError, UpdateGoalArgs, UpdateGoalResult, UpdateGoalSuccess, UpdateGoalToolCall } from "../../../../proto/generated/agent/v1/goal_tool_pb.ts";

function toRedactedCreateGoalArgs(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    objective: createRedactedString(msg.objective, DataClassification.CODE, "objective", privacyMode),
  };
}

function fromRedactedCreateGoalArgs(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new CreateGoalArgs({
    objective: msg.objective.unwrap(purpose, { redactUnallowedFieldsInsteadOfThrowing, enforcing }),
  });
}

function toRedactedCreateGoalResult_result(oneof, privacyMode) {
  if (oneof === void 0) {
    return { case: void 0, value: void 0 };
  }
  switch (oneof.case) {
    case "success":
      return { case: "success", value: toRedactedCreateGoalSuccess(oneof.value, privacyMode) };
    case "error":
      return { case: "error", value: toRedactedGoalError(oneof.value, privacyMode) };
    default:
      return { case: void 0, value: void 0 };
  }
}

function fromRedactedCreateGoalResult_result(oneof, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  if (oneof === void 0) {
    return { case: void 0, value: void 0 };
  }
  switch (oneof.case) {
    case "success":
      return { case: "success", value: fromRedactedCreateGoalSuccess(oneof.value, purpose, opts) };
    case "error":
      return { case: "error", value: fromRedactedGoalError(oneof.value, purpose, opts) };
    default:
      return { case: void 0, value: void 0 };
  }
}

function toRedactedCreateGoalResult(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    result: toRedactedCreateGoalResult_result(msg.result, privacyMode),
  };
}

function fromRedactedCreateGoalResult(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new CreateGoalResult({
    result: fromRedactedCreateGoalResult_result(msg.result, purpose, opts),
  });
}

function toRedactedCreateGoalSuccess(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
  };
}

function fromRedactedCreateGoalSuccess(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new CreateGoalSuccess({
  });
}

function toRedactedCreateGoalToolCall(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    args: msg.args !== void 0 ? toRedactedCreateGoalArgs(msg.args, privacyMode) : void 0,
    result: msg.result !== void 0 ? toRedactedCreateGoalResult(msg.result, privacyMode) : void 0,
  };
}

function fromRedactedCreateGoalToolCall(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new CreateGoalToolCall({
    args: msg.args !== void 0 ? fromRedactedCreateGoalArgs(msg.args, purpose, opts) : void 0,
    result: msg.result !== void 0 ? fromRedactedCreateGoalResult(msg.result, purpose, opts) : void 0,
  });
}

function toRedactedGoalError(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    error: createRedactedString(msg.error, DataClassification.CODE, "error", privacyMode),
  };
}

function fromRedactedGoalError(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new GoalError({
    error: msg.error.unwrap(purpose, { redactUnallowedFieldsInsteadOfThrowing, enforcing }),
  });
}

function toRedactedUpdateGoalArgs(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    status: msg.status,
  };
}

function fromRedactedUpdateGoalArgs(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new UpdateGoalArgs({
    status: msg.status,
  });
}

function toRedactedUpdateGoalResult_result(oneof, privacyMode) {
  if (oneof === void 0) {
    return { case: void 0, value: void 0 };
  }
  switch (oneof.case) {
    case "success":
      return { case: "success", value: toRedactedUpdateGoalSuccess(oneof.value, privacyMode) };
    case "error":
      return { case: "error", value: toRedactedGoalError(oneof.value, privacyMode) };
    default:
      return { case: void 0, value: void 0 };
  }
}

function fromRedactedUpdateGoalResult_result(oneof, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  if (oneof === void 0) {
    return { case: void 0, value: void 0 };
  }
  switch (oneof.case) {
    case "success":
      return { case: "success", value: fromRedactedUpdateGoalSuccess(oneof.value, purpose, opts) };
    case "error":
      return { case: "error", value: fromRedactedGoalError(oneof.value, purpose, opts) };
    default:
      return { case: void 0, value: void 0 };
  }
}

function toRedactedUpdateGoalResult(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    result: toRedactedUpdateGoalResult_result(msg.result, privacyMode),
  };
}

function fromRedactedUpdateGoalResult(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new UpdateGoalResult({
    result: fromRedactedUpdateGoalResult_result(msg.result, purpose, opts),
  });
}

function toRedactedUpdateGoalSuccess(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    status: msg.status,
  };
}

function fromRedactedUpdateGoalSuccess(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new UpdateGoalSuccess({
    status: msg.status,
  });
}

function toRedactedUpdateGoalToolCall(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    args: msg.args !== void 0 ? toRedactedUpdateGoalArgs(msg.args, privacyMode) : void 0,
    result: msg.result !== void 0 ? toRedactedUpdateGoalResult(msg.result, privacyMode) : void 0,
  };
}

function fromRedactedUpdateGoalToolCall(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new UpdateGoalToolCall({
    args: msg.args !== void 0 ? fromRedactedUpdateGoalArgs(msg.args, purpose, opts) : void 0,
    result: msg.result !== void 0 ? fromRedactedUpdateGoalResult(msg.result, purpose, opts) : void 0,
  });
}

export {
  toRedactedCreateGoalArgs,
  fromRedactedCreateGoalArgs,
  toRedactedCreateGoalResult,
  fromRedactedCreateGoalResult,
  toRedactedCreateGoalResult_result,
  fromRedactedCreateGoalResult_result,
  toRedactedCreateGoalSuccess,
  fromRedactedCreateGoalSuccess,
  toRedactedCreateGoalToolCall,
  fromRedactedCreateGoalToolCall,
  toRedactedGoalError,
  fromRedactedGoalError,
  toRedactedUpdateGoalArgs,
  fromRedactedUpdateGoalArgs,
  toRedactedUpdateGoalResult,
  fromRedactedUpdateGoalResult,
  toRedactedUpdateGoalResult_result,
  fromRedactedUpdateGoalResult_result,
  toRedactedUpdateGoalSuccess,
  fromRedactedUpdateGoalSuccess,
  toRedactedUpdateGoalToolCall,
  fromRedactedUpdateGoalToolCall,
};
