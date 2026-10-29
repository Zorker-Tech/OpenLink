// @ts-nocheck -- generated runtime: redaction changes a field's type structurally, so the
// declaration pass for these modules is a separate mechanical step.
//
// @generated from this repository's schema and redaction annotations. Do not edit.
//
// Regenerate with `pnpm --filter @slate/work-host redaction:generate`.
// Sensitive fields arrive as RedactedString/RedactedBytes; `fromRedacted*` asks for a purpose.
import { DataClassification } from "../../../../../../packages/redaction/classification.ts";
import { createRedactedString } from "../../../../../../packages/redaction/create.ts";
import { AppliedAgentChange, ApplyAgentDiffArgs, ApplyAgentDiffError, ApplyAgentDiffResult, ApplyAgentDiffSuccess, ApplyAgentDiffToolCall } from "../../../../proto/generated/agent/v1/apply_agent_diff_tool_pb.ts";

function toRedactedAppliedAgentChange(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    path: createRedactedString(msg.path, DataClassification.PATH, "path", privacyMode),
    changeType: msg.changeType,
    beforeContent: msg.beforeContent !== void 0 ? createRedactedString(msg.beforeContent, DataClassification.CODE, "before_content", privacyMode) : void 0,
    afterContent: msg.afterContent !== void 0 ? createRedactedString(msg.afterContent, DataClassification.CODE, "after_content", privacyMode) : void 0,
    error: msg.error !== void 0 ? createRedactedString(msg.error, DataClassification.CODE, "error", privacyMode) : void 0,
    messageForModel: msg.messageForModel !== void 0 ? createRedactedString(msg.messageForModel, DataClassification.CODE, "message_for_model", privacyMode) : void 0,
  };
}

function fromRedactedAppliedAgentChange(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new AppliedAgentChange({
    path: msg.path.unwrap(purpose, { redactUnallowedFieldsInsteadOfThrowing, enforcing }),
    changeType: msg.changeType,
    beforeContent: msg.beforeContent?.unwrap(purpose, { redactUnallowedFieldsInsteadOfThrowing, enforcing }),
    afterContent: msg.afterContent?.unwrap(purpose, { redactUnallowedFieldsInsteadOfThrowing, enforcing }),
    error: msg.error?.unwrap(purpose, { redactUnallowedFieldsInsteadOfThrowing, enforcing }),
    messageForModel: msg.messageForModel?.unwrap(purpose, { redactUnallowedFieldsInsteadOfThrowing, enforcing }),
  });
}

function toRedactedApplyAgentDiffArgs(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    agentId: msg.agentId,
  };
}

function fromRedactedApplyAgentDiffArgs(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new ApplyAgentDiffArgs({
    agentId: msg.agentId,
  });
}

function toRedactedApplyAgentDiffError(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    error: createRedactedString(msg.error, DataClassification.CODE, "error", privacyMode),
    appliedChanges: msg.appliedChanges.map((v2) => toRedactedAppliedAgentChange(v2, privacyMode)),
  };
}

function fromRedactedApplyAgentDiffError(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new ApplyAgentDiffError({
    error: msg.error.unwrap(purpose, { redactUnallowedFieldsInsteadOfThrowing, enforcing }),
    appliedChanges: msg.appliedChanges.map((v2) => fromRedactedAppliedAgentChange(v2, purpose, opts)),
  });
}

function toRedactedApplyAgentDiffResult_result(oneof, privacyMode) {
  if (oneof === void 0) {
    return { case: void 0, value: void 0 };
  }
  switch (oneof.case) {
    case "success":
      return { case: "success", value: toRedactedApplyAgentDiffSuccess(oneof.value, privacyMode) };
    case "error":
      return { case: "error", value: toRedactedApplyAgentDiffError(oneof.value, privacyMode) };
    default:
      return { case: void 0, value: void 0 };
  }
}

function fromRedactedApplyAgentDiffResult_result(oneof, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  if (oneof === void 0) {
    return { case: void 0, value: void 0 };
  }
  switch (oneof.case) {
    case "success":
      return { case: "success", value: fromRedactedApplyAgentDiffSuccess(oneof.value, purpose, opts) };
    case "error":
      return { case: "error", value: fromRedactedApplyAgentDiffError(oneof.value, purpose, opts) };
    default:
      return { case: void 0, value: void 0 };
  }
}

function toRedactedApplyAgentDiffResult(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    result: toRedactedApplyAgentDiffResult_result(msg.result, privacyMode),
  };
}

function fromRedactedApplyAgentDiffResult(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new ApplyAgentDiffResult({
    result: fromRedactedApplyAgentDiffResult_result(msg.result, purpose, opts),
  });
}

function toRedactedApplyAgentDiffSuccess(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    appliedChanges: msg.appliedChanges.map((v2) => toRedactedAppliedAgentChange(v2, privacyMode)),
  };
}

function fromRedactedApplyAgentDiffSuccess(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new ApplyAgentDiffSuccess({
    appliedChanges: msg.appliedChanges.map((v2) => fromRedactedAppliedAgentChange(v2, purpose, opts)),
  });
}

function toRedactedApplyAgentDiffToolCall(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    args: msg.args !== void 0 ? toRedactedApplyAgentDiffArgs(msg.args, privacyMode) : void 0,
    result: msg.result !== void 0 ? toRedactedApplyAgentDiffResult(msg.result, privacyMode) : void 0,
  };
}

function fromRedactedApplyAgentDiffToolCall(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new ApplyAgentDiffToolCall({
    args: msg.args !== void 0 ? fromRedactedApplyAgentDiffArgs(msg.args, purpose, opts) : void 0,
    result: msg.result !== void 0 ? fromRedactedApplyAgentDiffResult(msg.result, purpose, opts) : void 0,
  });
}

export {
  toRedactedAppliedAgentChange,
  fromRedactedAppliedAgentChange,
  toRedactedApplyAgentDiffArgs,
  fromRedactedApplyAgentDiffArgs,
  toRedactedApplyAgentDiffError,
  fromRedactedApplyAgentDiffError,
  toRedactedApplyAgentDiffResult,
  fromRedactedApplyAgentDiffResult,
  toRedactedApplyAgentDiffResult_result,
  fromRedactedApplyAgentDiffResult_result,
  toRedactedApplyAgentDiffSuccess,
  fromRedactedApplyAgentDiffSuccess,
  toRedactedApplyAgentDiffToolCall,
  fromRedactedApplyAgentDiffToolCall,
};
