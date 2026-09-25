// @ts-nocheck -- generated runtime: redaction changes a field's type structurally, so the
// declaration pass for these modules is a separate mechanical step.
//
// @generated from this repository's schema and redaction annotations. Do not edit.
//
// Regenerate with `pnpm --filter @slate/work-host redaction:generate`.
// Sensitive fields arrive as RedactedString/RedactedBytes; `fromRedacted*` asks for a purpose.
import { DataClassification } from "../../../../redaction/classification.ts";
import { createRedactedString } from "../../../../redaction/create.ts";
import { AdoptArgs, AdoptResult, AdoptToolCall } from "../../../../proto/generated/agent/v1/adopt_tool_pb.ts";

function toRedactedAdoptArgs(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    sourceAgentId: msg.sourceAgentId,
  };
}

function fromRedactedAdoptArgs(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new AdoptArgs({
    sourceAgentId: msg.sourceAgentId,
  });
}

function toRedactedAdoptResult_result(oneof, privacyMode) {
  if (oneof === void 0) {
    return { case: void 0, value: void 0 };
  }
  switch (oneof.case) {
    case "success":
      return { case: "success", value: oneof.value };
    case "error":
      return { case: "error", value: createRedactedString(oneof.value, DataClassification.CODE, "error", privacyMode) };
    default:
      return { case: void 0, value: void 0 };
  }
}

function fromRedactedAdoptResult_result(oneof, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  if (oneof === void 0) {
    return { case: void 0, value: void 0 };
  }
  switch (oneof.case) {
    case "success":
      return { case: "success", value: oneof.value };
    case "error":
      return { case: "error", value: oneof.value.unwrap(purpose, { redactUnallowedFieldsInsteadOfThrowing, enforcing }) };
    default:
      return { case: void 0, value: void 0 };
  }
}

function toRedactedAdoptResult(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    sourceAgentId: msg.sourceAgentId,
    targetAgentId: msg.targetAgentId,
    projectRootId: msg.projectRootId,
    result: toRedactedAdoptResult_result(msg.result, privacyMode),
  };
}

function fromRedactedAdoptResult(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new AdoptResult({
    sourceAgentId: msg.sourceAgentId,
    targetAgentId: msg.targetAgentId,
    projectRootId: msg.projectRootId,
    result: fromRedactedAdoptResult_result(msg.result, purpose, opts),
  });
}

function toRedactedAdoptToolCall(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    args: msg.args !== void 0 ? toRedactedAdoptArgs(msg.args, privacyMode) : void 0,
    result: msg.result !== void 0 ? toRedactedAdoptResult(msg.result, privacyMode) : void 0,
  };
}

function fromRedactedAdoptToolCall(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new AdoptToolCall({
    args: msg.args !== void 0 ? fromRedactedAdoptArgs(msg.args, purpose, opts) : void 0,
    result: msg.result !== void 0 ? fromRedactedAdoptResult(msg.result, purpose, opts) : void 0,
  });
}

export {
  toRedactedAdoptArgs,
  fromRedactedAdoptArgs,
  toRedactedAdoptResult,
  fromRedactedAdoptResult,
  toRedactedAdoptResult_result,
  fromRedactedAdoptResult_result,
  toRedactedAdoptToolCall,
  fromRedactedAdoptToolCall,
};
