// @ts-nocheck -- generated runtime: redaction changes a field's type structurally, so the
// declaration pass for these modules is a separate mechanical step.
//
// @generated from this repository's schema and redaction annotations. Do not edit.
//
// Regenerate with `pnpm --filter @slate/work-host redaction:generate`.
// Sensitive fields arrive as RedactedString/RedactedBytes; `fromRedacted*` asks for a purpose.
import { DataClassification } from "../../../../redaction/classification.ts";
import { createRedactedString } from "../../../../redaction/create.ts";
import { DiagnosticItem, DiagnosticRange, FileDiagnostics, ReadLintsToolArgs, ReadLintsToolCall, ReadLintsToolError, ReadLintsToolResult, ReadLintsToolSuccess } from "../../../../proto/generated/agent/v1/read_lints_tool_pb.ts";
import { Position } from "../../../../proto/generated/agent/v1/utils_pb.ts";
import { fromRedactedPosition, toRedactedPosition } from "./utils_redacted.ts";

function toRedactedDiagnosticItem(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    severity: msg.severity,
    range: msg.range !== void 0 ? toRedactedDiagnosticRange(msg.range, privacyMode) : void 0,
    message: createRedactedString(msg.message, DataClassification.CODE, "message", privacyMode),
    source: msg.source,
    code: msg.code,
    isStale: msg.isStale,
  };
}

function fromRedactedDiagnosticItem(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new DiagnosticItem({
    severity: msg.severity,
    range: msg.range !== void 0 ? fromRedactedDiagnosticRange(msg.range, purpose, opts) : void 0,
    message: msg.message.unwrap(purpose, { redactUnallowedFieldsInsteadOfThrowing, enforcing }),
    source: msg.source,
    code: msg.code,
    isStale: msg.isStale,
  });
}

function toRedactedDiagnosticRange(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    start: msg.start !== void 0 ? toRedactedPosition(msg.start, privacyMode) : void 0,
    end: msg.end !== void 0 ? toRedactedPosition(msg.end, privacyMode) : void 0,
  };
}

function fromRedactedDiagnosticRange(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new DiagnosticRange({
    start: msg.start !== void 0 ? fromRedactedPosition(msg.start, purpose, opts) : void 0,
    end: msg.end !== void 0 ? fromRedactedPosition(msg.end, purpose, opts) : void 0,
  });
}

function toRedactedFileDiagnostics(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    path: createRedactedString(msg.path, DataClassification.PATH, "path", privacyMode),
    diagnostics: msg.diagnostics.map((v2) => toRedactedDiagnosticItem(v2, privacyMode)),
    diagnosticsCount: msg.diagnosticsCount,
  };
}

function fromRedactedFileDiagnostics(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new FileDiagnostics({
    path: msg.path.unwrap(purpose, { redactUnallowedFieldsInsteadOfThrowing, enforcing }),
    diagnostics: msg.diagnostics.map((v2) => fromRedactedDiagnosticItem(v2, purpose, opts)),
    diagnosticsCount: msg.diagnosticsCount,
  });
}

function toRedactedReadLintsToolArgs(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    paths: msg.paths.map((v2) => createRedactedString(v2, DataClassification.PATH, "paths", privacyMode)),
  };
}

function fromRedactedReadLintsToolArgs(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new ReadLintsToolArgs({
    paths: msg.paths.map((v2) => v2.unwrap(purpose, { redactUnallowedFieldsInsteadOfThrowing, enforcing })),
  });
}

function toRedactedReadLintsToolCall(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    args: msg.args !== void 0 ? toRedactedReadLintsToolArgs(msg.args, privacyMode) : void 0,
    result: msg.result !== void 0 ? toRedactedReadLintsToolResult(msg.result, privacyMode) : void 0,
  };
}

function fromRedactedReadLintsToolCall(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new ReadLintsToolCall({
    args: msg.args !== void 0 ? fromRedactedReadLintsToolArgs(msg.args, purpose, opts) : void 0,
    result: msg.result !== void 0 ? fromRedactedReadLintsToolResult(msg.result, purpose, opts) : void 0,
  });
}

function toRedactedReadLintsToolError(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    errorMessage: createRedactedString(msg.errorMessage, DataClassification.CODE, "error_message", privacyMode),
  };
}

function fromRedactedReadLintsToolError(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new ReadLintsToolError({
    errorMessage: msg.errorMessage.unwrap(purpose, { redactUnallowedFieldsInsteadOfThrowing, enforcing }),
  });
}

function toRedactedReadLintsToolResult_result(oneof, privacyMode) {
  if (oneof === void 0) {
    return { case: void 0, value: void 0 };
  }
  switch (oneof.case) {
    case "success":
      return { case: "success", value: toRedactedReadLintsToolSuccess(oneof.value, privacyMode) };
    case "error":
      return { case: "error", value: toRedactedReadLintsToolError(oneof.value, privacyMode) };
    default:
      return { case: void 0, value: void 0 };
  }
}

function fromRedactedReadLintsToolResult_result(oneof, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  if (oneof === void 0) {
    return { case: void 0, value: void 0 };
  }
  switch (oneof.case) {
    case "success":
      return { case: "success", value: fromRedactedReadLintsToolSuccess(oneof.value, purpose, opts) };
    case "error":
      return { case: "error", value: fromRedactedReadLintsToolError(oneof.value, purpose, opts) };
    default:
      return { case: void 0, value: void 0 };
  }
}

function toRedactedReadLintsToolResult(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    result: toRedactedReadLintsToolResult_result(msg.result, privacyMode),
  };
}

function fromRedactedReadLintsToolResult(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new ReadLintsToolResult({
    result: fromRedactedReadLintsToolResult_result(msg.result, purpose, opts),
  });
}

function toRedactedReadLintsToolSuccess(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    fileDiagnostics: msg.fileDiagnostics.map((v2) => toRedactedFileDiagnostics(v2, privacyMode)),
    totalFiles: msg.totalFiles,
    totalDiagnostics: msg.totalDiagnostics,
  };
}

function fromRedactedReadLintsToolSuccess(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new ReadLintsToolSuccess({
    fileDiagnostics: msg.fileDiagnostics.map((v2) => fromRedactedFileDiagnostics(v2, purpose, opts)),
    totalFiles: msg.totalFiles,
    totalDiagnostics: msg.totalDiagnostics,
  });
}

export {
  toRedactedDiagnosticItem,
  fromRedactedDiagnosticItem,
  toRedactedDiagnosticRange,
  fromRedactedDiagnosticRange,
  toRedactedFileDiagnostics,
  fromRedactedFileDiagnostics,
  toRedactedReadLintsToolArgs,
  fromRedactedReadLintsToolArgs,
  toRedactedReadLintsToolCall,
  fromRedactedReadLintsToolCall,
  toRedactedReadLintsToolError,
  fromRedactedReadLintsToolError,
  toRedactedReadLintsToolResult,
  fromRedactedReadLintsToolResult,
  toRedactedReadLintsToolResult_result,
  fromRedactedReadLintsToolResult_result,
  toRedactedReadLintsToolSuccess,
  fromRedactedReadLintsToolSuccess,
};
