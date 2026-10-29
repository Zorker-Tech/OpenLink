// @ts-nocheck -- generated runtime: redaction changes a field's type structurally, so the
// declaration pass for these modules is a separate mechanical step.
//
// @generated from this repository's schema and redaction annotations. Do not edit.
//
// Regenerate with `pnpm --filter @slate/work-host redaction:generate`.
// Sensitive fields arrive as RedactedString/RedactedBytes; `fromRedacted*` asks for a purpose.
import { DataClassification } from "../../../../../../packages/redaction/classification.ts";
import { createRedactedString } from "../../../../../../packages/redaction/create.ts";
import { FetchArgs, FetchError, FetchResult, FetchSuccess } from "../../../../proto/generated/agent/v1/fetch_exec_pb.ts";

function toRedactedFetchArgs(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    url: msg.url,
    toolCallId: msg.toolCallId,
  };
}

function fromRedactedFetchArgs(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new FetchArgs({
    url: msg.url,
    toolCallId: msg.toolCallId,
  });
}

function toRedactedFetchError(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    url: msg.url,
    error: createRedactedString(msg.error, DataClassification.CODE, "error", privacyMode),
  };
}

function fromRedactedFetchError(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new FetchError({
    url: msg.url,
    error: msg.error.unwrap(purpose, { redactUnallowedFieldsInsteadOfThrowing, enforcing }),
  });
}

function toRedactedFetchResult_result(oneof, privacyMode) {
  if (oneof === void 0) {
    return { case: void 0, value: void 0 };
  }
  switch (oneof.case) {
    case "success":
      return { case: "success", value: toRedactedFetchSuccess(oneof.value, privacyMode) };
    case "error":
      return { case: "error", value: toRedactedFetchError(oneof.value, privacyMode) };
    default:
      return { case: void 0, value: void 0 };
  }
}

function fromRedactedFetchResult_result(oneof, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  if (oneof === void 0) {
    return { case: void 0, value: void 0 };
  }
  switch (oneof.case) {
    case "success":
      return { case: "success", value: fromRedactedFetchSuccess(oneof.value, purpose, opts) };
    case "error":
      return { case: "error", value: fromRedactedFetchError(oneof.value, purpose, opts) };
    default:
      return { case: void 0, value: void 0 };
  }
}

function toRedactedFetchResult(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    result: toRedactedFetchResult_result(msg.result, privacyMode),
  };
}

function fromRedactedFetchResult(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new FetchResult({
    result: fromRedactedFetchResult_result(msg.result, purpose, opts),
  });
}

function toRedactedFetchSuccess(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    url: msg.url,
    content: createRedactedString(msg.content, DataClassification.CODE, "content", privacyMode),
    statusCode: msg.statusCode,
    contentType: msg.contentType,
  };
}

function fromRedactedFetchSuccess(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new FetchSuccess({
    url: msg.url,
    content: msg.content.unwrap(purpose, { redactUnallowedFieldsInsteadOfThrowing, enforcing }),
    statusCode: msg.statusCode,
    contentType: msg.contentType,
  });
}

export {
  toRedactedFetchArgs,
  fromRedactedFetchArgs,
  toRedactedFetchError,
  fromRedactedFetchError,
  toRedactedFetchResult,
  fromRedactedFetchResult,
  toRedactedFetchResult_result,
  fromRedactedFetchResult_result,
  toRedactedFetchSuccess,
  fromRedactedFetchSuccess,
};
