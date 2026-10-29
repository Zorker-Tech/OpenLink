// @ts-nocheck -- generated runtime: redaction changes a field's type structurally, so the
// declaration pass for these modules is a separate mechanical step.
//
// @generated from this repository's schema and redaction annotations. Do not edit.
//
// Regenerate with `pnpm --filter @slate/work-host redaction:generate`.
// Sensitive fields arrive as RedactedString/RedactedBytes; `fromRedacted*` asks for a purpose.
import { DataClassification } from "../../../../../../packages/redaction/classification.ts";
import { createRedactedString } from "../../../../../../packages/redaction/create.ts";
import { ReflectArgs, ReflectError, ReflectResult, ReflectSuccess, ReflectToolCall } from "../../../../proto/generated/agent/v1/reflect_tool_pb.ts";

function toRedactedReflectArgs(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    unexpectedActionOutcomes: createRedactedString(msg.unexpectedActionOutcomes, DataClassification.CODE, "unexpected_action_outcomes", privacyMode),
    relevantInstructions: createRedactedString(msg.relevantInstructions, DataClassification.CODE, "relevant_instructions", privacyMode),
    scenarioAnalysis: createRedactedString(msg.scenarioAnalysis, DataClassification.CODE, "scenario_analysis", privacyMode),
    criticalSynthesis: createRedactedString(msg.criticalSynthesis, DataClassification.CODE, "critical_synthesis", privacyMode),
    nextSteps: createRedactedString(msg.nextSteps, DataClassification.CODE, "next_steps", privacyMode),
    toolCallId: msg.toolCallId,
  };
}

function fromRedactedReflectArgs(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new ReflectArgs({
    unexpectedActionOutcomes: msg.unexpectedActionOutcomes.unwrap(purpose, { redactUnallowedFieldsInsteadOfThrowing, enforcing }),
    relevantInstructions: msg.relevantInstructions.unwrap(purpose, { redactUnallowedFieldsInsteadOfThrowing, enforcing }),
    scenarioAnalysis: msg.scenarioAnalysis.unwrap(purpose, { redactUnallowedFieldsInsteadOfThrowing, enforcing }),
    criticalSynthesis: msg.criticalSynthesis.unwrap(purpose, { redactUnallowedFieldsInsteadOfThrowing, enforcing }),
    nextSteps: msg.nextSteps.unwrap(purpose, { redactUnallowedFieldsInsteadOfThrowing, enforcing }),
    toolCallId: msg.toolCallId,
  });
}

function toRedactedReflectError(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    error: createRedactedString(msg.error, DataClassification.CODE, "error", privacyMode),
  };
}

function fromRedactedReflectError(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new ReflectError({
    error: msg.error.unwrap(purpose, { redactUnallowedFieldsInsteadOfThrowing, enforcing }),
  });
}

function toRedactedReflectResult_result(oneof, privacyMode) {
  if (oneof === void 0) {
    return { case: void 0, value: void 0 };
  }
  switch (oneof.case) {
    case "success":
      return { case: "success", value: toRedactedReflectSuccess(oneof.value, privacyMode) };
    case "error":
      return { case: "error", value: toRedactedReflectError(oneof.value, privacyMode) };
    default:
      return { case: void 0, value: void 0 };
  }
}

function fromRedactedReflectResult_result(oneof, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  if (oneof === void 0) {
    return { case: void 0, value: void 0 };
  }
  switch (oneof.case) {
    case "success":
      return { case: "success", value: fromRedactedReflectSuccess(oneof.value, purpose, opts) };
    case "error":
      return { case: "error", value: fromRedactedReflectError(oneof.value, purpose, opts) };
    default:
      return { case: void 0, value: void 0 };
  }
}

function toRedactedReflectResult(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    result: toRedactedReflectResult_result(msg.result, privacyMode),
  };
}

function fromRedactedReflectResult(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new ReflectResult({
    result: fromRedactedReflectResult_result(msg.result, purpose, opts),
  });
}

function toRedactedReflectSuccess(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
  };
}

function fromRedactedReflectSuccess(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new ReflectSuccess({
  });
}

function toRedactedReflectToolCall(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    args: msg.args !== void 0 ? toRedactedReflectArgs(msg.args, privacyMode) : void 0,
    result: msg.result !== void 0 ? toRedactedReflectResult(msg.result, privacyMode) : void 0,
  };
}

function fromRedactedReflectToolCall(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new ReflectToolCall({
    args: msg.args !== void 0 ? fromRedactedReflectArgs(msg.args, purpose, opts) : void 0,
    result: msg.result !== void 0 ? fromRedactedReflectResult(msg.result, purpose, opts) : void 0,
  });
}

export {
  toRedactedReflectArgs,
  fromRedactedReflectArgs,
  toRedactedReflectError,
  fromRedactedReflectError,
  toRedactedReflectResult,
  fromRedactedReflectResult,
  toRedactedReflectResult_result,
  fromRedactedReflectResult_result,
  toRedactedReflectSuccess,
  fromRedactedReflectSuccess,
  toRedactedReflectToolCall,
  fromRedactedReflectToolCall,
};
