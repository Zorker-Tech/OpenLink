// @ts-nocheck -- generated runtime: redaction changes a field's type structurally, so the
// declaration pass for these modules is a separate mechanical step.
//
// @generated from this repository's schema and redaction annotations. Do not edit.
//
// Regenerate with `pnpm --filter @slate/work-host redaction:generate`.
// Sensitive fields arrive as RedactedString/RedactedBytes; `fromRedacted*` asks for a purpose.
import { DataClassification } from "../../../../redaction/classification.ts";
import { createRedactedString } from "../../../../redaction/create.ts";
import { WriteShellStdinArgs, WriteShellStdinError, WriteShellStdinResult, WriteShellStdinSuccess } from "../../../../proto/generated/agent/v1/background_shell_exec_pb.ts";

function toRedactedWriteShellStdinArgs(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    shellId: msg.shellId,
    chars: createRedactedString(msg.chars, DataClassification.CODE, "chars", privacyMode),
  };
}

function fromRedactedWriteShellStdinArgs(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new WriteShellStdinArgs({
    shellId: msg.shellId,
    chars: msg.chars.unwrap(purpose, { redactUnallowedFieldsInsteadOfThrowing, enforcing }),
  });
}

function toRedactedWriteShellStdinError(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    error: createRedactedString(msg.error, DataClassification.CODE, "error", privacyMode),
  };
}

function fromRedactedWriteShellStdinError(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new WriteShellStdinError({
    error: msg.error.unwrap(purpose, { redactUnallowedFieldsInsteadOfThrowing, enforcing }),
  });
}

function toRedactedWriteShellStdinResult_result(oneof, privacyMode) {
  if (oneof === void 0) {
    return { case: void 0, value: void 0 };
  }
  switch (oneof.case) {
    case "success":
      return { case: "success", value: toRedactedWriteShellStdinSuccess(oneof.value, privacyMode) };
    case "error":
      return { case: "error", value: toRedactedWriteShellStdinError(oneof.value, privacyMode) };
    default:
      return { case: void 0, value: void 0 };
  }
}

function fromRedactedWriteShellStdinResult_result(oneof, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  if (oneof === void 0) {
    return { case: void 0, value: void 0 };
  }
  switch (oneof.case) {
    case "success":
      return { case: "success", value: fromRedactedWriteShellStdinSuccess(oneof.value, purpose, opts) };
    case "error":
      return { case: "error", value: fromRedactedWriteShellStdinError(oneof.value, purpose, opts) };
    default:
      return { case: void 0, value: void 0 };
  }
}

function toRedactedWriteShellStdinResult(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    result: toRedactedWriteShellStdinResult_result(msg.result, privacyMode),
  };
}

function fromRedactedWriteShellStdinResult(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new WriteShellStdinResult({
    result: fromRedactedWriteShellStdinResult_result(msg.result, purpose, opts),
  });
}

function toRedactedWriteShellStdinSuccess(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    shellId: msg.shellId,
    terminalFileLengthBeforeInputWritten: msg.terminalFileLengthBeforeInputWritten,
  };
}

function fromRedactedWriteShellStdinSuccess(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new WriteShellStdinSuccess({
    shellId: msg.shellId,
    terminalFileLengthBeforeInputWritten: msg.terminalFileLengthBeforeInputWritten,
  });
}

export {
  toRedactedWriteShellStdinArgs,
  fromRedactedWriteShellStdinArgs,
  toRedactedWriteShellStdinError,
  fromRedactedWriteShellStdinError,
  toRedactedWriteShellStdinResult,
  fromRedactedWriteShellStdinResult,
  toRedactedWriteShellStdinResult_result,
  fromRedactedWriteShellStdinResult_result,
  toRedactedWriteShellStdinSuccess,
  fromRedactedWriteShellStdinSuccess,
};
