// @ts-nocheck -- generated runtime: redaction changes a field's type structurally, so the
// declaration pass for these modules is a separate mechanical step.
//
// @generated from this repository's schema and redaction annotations. Do not edit.
//
// Regenerate with `pnpm --filter @slate/work-host redaction:generate`.
// Sensitive fields arrive as RedactedString/RedactedBytes; `fromRedacted*` asks for a purpose.
import { DataClassification } from "../../../../../../packages/redaction/classification.ts";
import { createRedactedString } from "../../../../../../packages/redaction/create.ts";
import { GlobToolArgs, GlobToolCall, GlobToolError, GlobToolResult, GlobToolSuccess } from "../../../../proto/generated/agent/v1/glob_tool_pb.ts";

function toRedactedGlobToolArgs(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    targetDirectory: msg.targetDirectory !== void 0 ? createRedactedString(msg.targetDirectory, DataClassification.PATH, "target_directory", privacyMode) : void 0,
    globPattern: createRedactedString(msg.globPattern, DataClassification.PATH, "glob_pattern", privacyMode),
  };
}

function fromRedactedGlobToolArgs(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new GlobToolArgs({
    targetDirectory: msg.targetDirectory?.unwrap(purpose, { redactUnallowedFieldsInsteadOfThrowing, enforcing }),
    globPattern: msg.globPattern.unwrap(purpose, { redactUnallowedFieldsInsteadOfThrowing, enforcing }),
  });
}

function toRedactedGlobToolCall(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    args: msg.args !== void 0 ? toRedactedGlobToolArgs(msg.args, privacyMode) : void 0,
    result: msg.result !== void 0 ? toRedactedGlobToolResult(msg.result, privacyMode) : void 0,
  };
}

function fromRedactedGlobToolCall(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new GlobToolCall({
    args: msg.args !== void 0 ? fromRedactedGlobToolArgs(msg.args, purpose, opts) : void 0,
    result: msg.result !== void 0 ? fromRedactedGlobToolResult(msg.result, purpose, opts) : void 0,
  });
}

function toRedactedGlobToolError(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    error: createRedactedString(msg.error, DataClassification.CODE, "error", privacyMode),
  };
}

function fromRedactedGlobToolError(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new GlobToolError({
    error: msg.error.unwrap(purpose, { redactUnallowedFieldsInsteadOfThrowing, enforcing }),
  });
}

function toRedactedGlobToolResult_result(oneof, privacyMode) {
  if (oneof === void 0) {
    return { case: void 0, value: void 0 };
  }
  switch (oneof.case) {
    case "success":
      return { case: "success", value: toRedactedGlobToolSuccess(oneof.value, privacyMode) };
    case "error":
      return { case: "error", value: toRedactedGlobToolError(oneof.value, privacyMode) };
    default:
      return { case: void 0, value: void 0 };
  }
}

function fromRedactedGlobToolResult_result(oneof, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  if (oneof === void 0) {
    return { case: void 0, value: void 0 };
  }
  switch (oneof.case) {
    case "success":
      return { case: "success", value: fromRedactedGlobToolSuccess(oneof.value, purpose, opts) };
    case "error":
      return { case: "error", value: fromRedactedGlobToolError(oneof.value, purpose, opts) };
    default:
      return { case: void 0, value: void 0 };
  }
}

function toRedactedGlobToolResult(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    result: toRedactedGlobToolResult_result(msg.result, privacyMode),
  };
}

function fromRedactedGlobToolResult(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new GlobToolResult({
    result: fromRedactedGlobToolResult_result(msg.result, purpose, opts),
  });
}

function toRedactedGlobToolSuccess(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    pattern: createRedactedString(msg.pattern, DataClassification.PATH, "pattern", privacyMode),
    path: createRedactedString(msg.path, DataClassification.PATH, "path", privacyMode),
    files: msg.files.map((v2) => createRedactedString(v2, DataClassification.PATH, "files", privacyMode)),
    totalFiles: msg.totalFiles,
    clientTruncated: msg.clientTruncated,
    ripgrepTruncated: msg.ripgrepTruncated,
  };
}

function fromRedactedGlobToolSuccess(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new GlobToolSuccess({
    pattern: msg.pattern.unwrap(purpose, { redactUnallowedFieldsInsteadOfThrowing, enforcing }),
    path: msg.path.unwrap(purpose, { redactUnallowedFieldsInsteadOfThrowing, enforcing }),
    files: msg.files.map((v2) => v2.unwrap(purpose, { redactUnallowedFieldsInsteadOfThrowing, enforcing })),
    totalFiles: msg.totalFiles,
    clientTruncated: msg.clientTruncated,
    ripgrepTruncated: msg.ripgrepTruncated,
  });
}

export {
  toRedactedGlobToolArgs,
  fromRedactedGlobToolArgs,
  toRedactedGlobToolCall,
  fromRedactedGlobToolCall,
  toRedactedGlobToolError,
  fromRedactedGlobToolError,
  toRedactedGlobToolResult,
  fromRedactedGlobToolResult,
  toRedactedGlobToolResult_result,
  fromRedactedGlobToolResult_result,
  toRedactedGlobToolSuccess,
  fromRedactedGlobToolSuccess,
};
