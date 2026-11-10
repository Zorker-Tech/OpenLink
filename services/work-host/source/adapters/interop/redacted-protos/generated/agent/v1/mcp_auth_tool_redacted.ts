// @ts-nocheck -- generated runtime: redaction changes a field's type structurally, so the
// declaration pass for these modules is a separate mechanical step.
//
// @generated from this repository's schema and redaction annotations. Do not edit.
//
// Regenerate with `pnpm --filter @slate/work-host redaction:generate`.
// Sensitive fields arrive as RedactedString/RedactedBytes; `fromRedacted*` asks for a purpose.
import { DataClassification } from "../../../../../../packages/redaction/classification.ts";
import { createRedactedString } from "../../../../../../packages/redaction/create.ts";
import { McpAuthArgs, McpAuthError, McpAuthRejected, McpAuthRequestQuery, McpAuthRequestResponse, McpAuthRequestResponse_Approved, McpAuthRequestResponse_Rejected, McpAuthResult, McpAuthSuccess, McpAuthToolCall } from "../../../../proto/generated/agent/v1/mcp_auth_tool_pb.ts";

function toRedactedMcpAuthArgs(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    serverIdentifier: msg.serverIdentifier,
    toolCallId: msg.toolCallId,
  };
}

function fromRedactedMcpAuthArgs(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new McpAuthArgs({
    serverIdentifier: msg.serverIdentifier,
    toolCallId: msg.toolCallId,
  });
}

function toRedactedMcpAuthError(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    error: createRedactedString(msg.error, DataClassification.CODE, "error", privacyMode),
  };
}

function fromRedactedMcpAuthError(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new McpAuthError({
    error: msg.error.unwrap(purpose, { redactUnallowedFieldsInsteadOfThrowing, enforcing }),
  });
}

function toRedactedMcpAuthRejected(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    reason: createRedactedString(msg.reason, DataClassification.CODE, "reason", privacyMode),
  };
}

function fromRedactedMcpAuthRejected(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new McpAuthRejected({
    reason: msg.reason.unwrap(purpose, { redactUnallowedFieldsInsteadOfThrowing, enforcing }),
  });
}

function toRedactedMcpAuthRequestQuery(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    args: msg.args !== void 0 ? toRedactedMcpAuthArgs(msg.args, privacyMode) : void 0,
  };
}

function fromRedactedMcpAuthRequestQuery(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new McpAuthRequestQuery({
    args: msg.args !== void 0 ? fromRedactedMcpAuthArgs(msg.args, purpose, opts) : void 0,
  });
}

function toRedactedMcpAuthRequestResponse_result(oneof, privacyMode) {
  if (oneof === void 0) {
    return { case: void 0, value: void 0 };
  }
  switch (oneof.case) {
    case "approved":
      return { case: "approved", value: toRedactedMcpAuthRequestResponse_Approved(oneof.value, privacyMode) };
    case "rejected":
      return { case: "rejected", value: toRedactedMcpAuthRequestResponse_Rejected(oneof.value, privacyMode) };
    default:
      return { case: void 0, value: void 0 };
  }
}

function fromRedactedMcpAuthRequestResponse_result(oneof, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  if (oneof === void 0) {
    return { case: void 0, value: void 0 };
  }
  switch (oneof.case) {
    case "approved":
      return { case: "approved", value: fromRedactedMcpAuthRequestResponse_Approved(oneof.value, purpose, opts) };
    case "rejected":
      return { case: "rejected", value: fromRedactedMcpAuthRequestResponse_Rejected(oneof.value, purpose, opts) };
    default:
      return { case: void 0, value: void 0 };
  }
}

function toRedactedMcpAuthRequestResponse(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    result: toRedactedMcpAuthRequestResponse_result(msg.result, privacyMode),
  };
}

function fromRedactedMcpAuthRequestResponse(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new McpAuthRequestResponse({
    result: fromRedactedMcpAuthRequestResponse_result(msg.result, purpose, opts),
  });
}

function toRedactedMcpAuthRequestResponse_Approved(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
  };
}

function fromRedactedMcpAuthRequestResponse_Approved(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new McpAuthRequestResponse_Approved({
  });
}

function toRedactedMcpAuthRequestResponse_Rejected(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    reason: createRedactedString(msg.reason, DataClassification.CODE, "reason", privacyMode),
  };
}

function fromRedactedMcpAuthRequestResponse_Rejected(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new McpAuthRequestResponse_Rejected({
    reason: msg.reason.unwrap(purpose, { redactUnallowedFieldsInsteadOfThrowing, enforcing }),
  });
}

function toRedactedMcpAuthResult_result(oneof, privacyMode) {
  if (oneof === void 0) {
    return { case: void 0, value: void 0 };
  }
  switch (oneof.case) {
    case "success":
      return { case: "success", value: toRedactedMcpAuthSuccess(oneof.value, privacyMode) };
    case "error":
      return { case: "error", value: toRedactedMcpAuthError(oneof.value, privacyMode) };
    case "rejected":
      return { case: "rejected", value: toRedactedMcpAuthRejected(oneof.value, privacyMode) };
    default:
      return { case: void 0, value: void 0 };
  }
}

function fromRedactedMcpAuthResult_result(oneof, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  if (oneof === void 0) {
    return { case: void 0, value: void 0 };
  }
  switch (oneof.case) {
    case "success":
      return { case: "success", value: fromRedactedMcpAuthSuccess(oneof.value, purpose, opts) };
    case "error":
      return { case: "error", value: fromRedactedMcpAuthError(oneof.value, purpose, opts) };
    case "rejected":
      return { case: "rejected", value: fromRedactedMcpAuthRejected(oneof.value, purpose, opts) };
    default:
      return { case: void 0, value: void 0 };
  }
}

function toRedactedMcpAuthResult(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    result: toRedactedMcpAuthResult_result(msg.result, privacyMode),
  };
}

function fromRedactedMcpAuthResult(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new McpAuthResult({
    result: fromRedactedMcpAuthResult_result(msg.result, purpose, opts),
  });
}

function toRedactedMcpAuthSuccess(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    serverIdentifier: msg.serverIdentifier,
  };
}

function fromRedactedMcpAuthSuccess(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new McpAuthSuccess({
    serverIdentifier: msg.serverIdentifier,
  });
}

function toRedactedMcpAuthToolCall(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    args: msg.args !== void 0 ? toRedactedMcpAuthArgs(msg.args, privacyMode) : void 0,
    result: msg.result !== void 0 ? toRedactedMcpAuthResult(msg.result, privacyMode) : void 0,
  };
}

function fromRedactedMcpAuthToolCall(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new McpAuthToolCall({
    args: msg.args !== void 0 ? fromRedactedMcpAuthArgs(msg.args, purpose, opts) : void 0,
    result: msg.result !== void 0 ? fromRedactedMcpAuthResult(msg.result, purpose, opts) : void 0,
  });
}

export {
  toRedactedMcpAuthArgs,
  fromRedactedMcpAuthArgs,
  toRedactedMcpAuthError,
  fromRedactedMcpAuthError,
  toRedactedMcpAuthRejected,
  fromRedactedMcpAuthRejected,
  toRedactedMcpAuthRequestQuery,
  fromRedactedMcpAuthRequestQuery,
  toRedactedMcpAuthRequestResponse,
  fromRedactedMcpAuthRequestResponse,
  toRedactedMcpAuthRequestResponse_result,
  fromRedactedMcpAuthRequestResponse_result,
  toRedactedMcpAuthRequestResponse_Approved,
  fromRedactedMcpAuthRequestResponse_Approved,
  toRedactedMcpAuthRequestResponse_Rejected,
  fromRedactedMcpAuthRequestResponse_Rejected,
  toRedactedMcpAuthResult,
  fromRedactedMcpAuthResult,
  toRedactedMcpAuthResult_result,
  fromRedactedMcpAuthResult_result,
  toRedactedMcpAuthSuccess,
  fromRedactedMcpAuthSuccess,
  toRedactedMcpAuthToolCall,
  fromRedactedMcpAuthToolCall,
};
