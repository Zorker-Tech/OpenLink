// @ts-nocheck -- generated runtime: redaction changes a field's type structurally, so the
// declaration pass for these modules is a separate mechanical step.
//
// @generated from this repository's schema and redaction annotations. Do not edit.
//
// Regenerate with `pnpm --filter @slate/work-host redaction:generate`.
// Sensitive fields arrive as RedactedString/RedactedBytes; `fromRedacted*` asks for a purpose.
import { DataClassification } from "../../../../../../packages/redaction/classification.ts";
import { createRedactedString } from "../../../../../../packages/redaction/create.ts";
import { ConnectScmArgs, ConnectScmError, ConnectScmGithub, ConnectScmGithubRepository, ConnectScmRejected, ConnectScmRequestQuery, ConnectScmRequestResponse, ConnectScmRequestResponse_Approved, ConnectScmRequestResponse_Failed, ConnectScmRequestResponse_Rejected, ConnectScmResult, ConnectScmSuccess, ConnectScmToolCall } from "../../../../proto/generated/agent/v1/connect_scm_tool_pb.ts";

function toRedactedConnectScmArgs_target(oneof, privacyMode) {
  if (oneof === void 0) {
    return { case: void 0, value: void 0 };
  }
  switch (oneof.case) {
    case "github":
      return { case: "github", value: toRedactedConnectScmGithub(oneof.value, privacyMode) };
    default:
      return { case: void 0, value: void 0 };
  }
}

function fromRedactedConnectScmArgs_target(oneof, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  if (oneof === void 0) {
    return { case: void 0, value: void 0 };
  }
  switch (oneof.case) {
    case "github":
      return { case: "github", value: fromRedactedConnectScmGithub(oneof.value, purpose, opts) };
    default:
      return { case: void 0, value: void 0 };
  }
}

function toRedactedConnectScmArgs(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    toolCallId: msg.toolCallId,
    target: toRedactedConnectScmArgs_target(msg.target, privacyMode),
  };
}

function fromRedactedConnectScmArgs(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new ConnectScmArgs({
    toolCallId: msg.toolCallId,
    target: fromRedactedConnectScmArgs_target(msg.target, purpose, opts),
  });
}

function toRedactedConnectScmError(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    error: createRedactedString(msg.error, DataClassification.CODE, "error", privacyMode),
  };
}

function fromRedactedConnectScmError(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new ConnectScmError({
    error: msg.error.unwrap(purpose, { redactUnallowedFieldsInsteadOfThrowing, enforcing }),
  });
}

function toRedactedConnectScmGithub(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    repository: msg.repository !== void 0 ? toRedactedConnectScmGithubRepository(msg.repository, privacyMode) : void 0,
    gheApplication: msg.gheApplication,
  };
}

function fromRedactedConnectScmGithub(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new ConnectScmGithub({
    repository: msg.repository !== void 0 ? fromRedactedConnectScmGithubRepository(msg.repository, purpose, opts) : void 0,
    gheApplication: msg.gheApplication,
  });
}

function toRedactedConnectScmGithubRepository(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    owner: msg.owner,
    repo: msg.repo,
  };
}

function fromRedactedConnectScmGithubRepository(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new ConnectScmGithubRepository({
    owner: msg.owner,
    repo: msg.repo,
  });
}

function toRedactedConnectScmRejected(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    reason: createRedactedString(msg.reason, DataClassification.CODE, "reason", privacyMode),
  };
}

function fromRedactedConnectScmRejected(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new ConnectScmRejected({
    reason: msg.reason.unwrap(purpose, { redactUnallowedFieldsInsteadOfThrowing, enforcing }),
  });
}

function toRedactedConnectScmRequestQuery(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    args: msg.args !== void 0 ? toRedactedConnectScmArgs(msg.args, privacyMode) : void 0,
  };
}

function fromRedactedConnectScmRequestQuery(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new ConnectScmRequestQuery({
    args: msg.args !== void 0 ? fromRedactedConnectScmArgs(msg.args, purpose, opts) : void 0,
  });
}

function toRedactedConnectScmRequestResponse_result(oneof, privacyMode) {
  if (oneof === void 0) {
    return { case: void 0, value: void 0 };
  }
  switch (oneof.case) {
    case "approved":
      return { case: "approved", value: toRedactedConnectScmRequestResponse_Approved(oneof.value, privacyMode) };
    case "rejected":
      return { case: "rejected", value: toRedactedConnectScmRequestResponse_Rejected(oneof.value, privacyMode) };
    case "failed":
      return { case: "failed", value: toRedactedConnectScmRequestResponse_Failed(oneof.value, privacyMode) };
    default:
      return { case: void 0, value: void 0 };
  }
}

function fromRedactedConnectScmRequestResponse_result(oneof, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  if (oneof === void 0) {
    return { case: void 0, value: void 0 };
  }
  switch (oneof.case) {
    case "approved":
      return { case: "approved", value: fromRedactedConnectScmRequestResponse_Approved(oneof.value, purpose, opts) };
    case "rejected":
      return { case: "rejected", value: fromRedactedConnectScmRequestResponse_Rejected(oneof.value, purpose, opts) };
    case "failed":
      return { case: "failed", value: fromRedactedConnectScmRequestResponse_Failed(oneof.value, purpose, opts) };
    default:
      return { case: void 0, value: void 0 };
  }
}

function toRedactedConnectScmRequestResponse(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    result: toRedactedConnectScmRequestResponse_result(msg.result, privacyMode),
  };
}

function fromRedactedConnectScmRequestResponse(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new ConnectScmRequestResponse({
    result: fromRedactedConnectScmRequestResponse_result(msg.result, purpose, opts),
  });
}

function toRedactedConnectScmRequestResponse_Approved(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
  };
}

function fromRedactedConnectScmRequestResponse_Approved(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new ConnectScmRequestResponse_Approved({
  });
}

function toRedactedConnectScmRequestResponse_Failed(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    error: createRedactedString(msg.error, DataClassification.CODE, "error", privacyMode),
  };
}

function fromRedactedConnectScmRequestResponse_Failed(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new ConnectScmRequestResponse_Failed({
    error: msg.error.unwrap(purpose, { redactUnallowedFieldsInsteadOfThrowing, enforcing }),
  });
}

function toRedactedConnectScmRequestResponse_Rejected(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    reason: createRedactedString(msg.reason, DataClassification.CODE, "reason", privacyMode),
  };
}

function fromRedactedConnectScmRequestResponse_Rejected(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new ConnectScmRequestResponse_Rejected({
    reason: msg.reason.unwrap(purpose, { redactUnallowedFieldsInsteadOfThrowing, enforcing }),
  });
}

function toRedactedConnectScmResult_result(oneof, privacyMode) {
  if (oneof === void 0) {
    return { case: void 0, value: void 0 };
  }
  switch (oneof.case) {
    case "success":
      return { case: "success", value: toRedactedConnectScmSuccess(oneof.value, privacyMode) };
    case "error":
      return { case: "error", value: toRedactedConnectScmError(oneof.value, privacyMode) };
    case "rejected":
      return { case: "rejected", value: toRedactedConnectScmRejected(oneof.value, privacyMode) };
    default:
      return { case: void 0, value: void 0 };
  }
}

function fromRedactedConnectScmResult_result(oneof, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  if (oneof === void 0) {
    return { case: void 0, value: void 0 };
  }
  switch (oneof.case) {
    case "success":
      return { case: "success", value: fromRedactedConnectScmSuccess(oneof.value, purpose, opts) };
    case "error":
      return { case: "error", value: fromRedactedConnectScmError(oneof.value, purpose, opts) };
    case "rejected":
      return { case: "rejected", value: fromRedactedConnectScmRejected(oneof.value, purpose, opts) };
    default:
      return { case: void 0, value: void 0 };
  }
}

function toRedactedConnectScmResult(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    result: toRedactedConnectScmResult_result(msg.result, privacyMode),
  };
}

function fromRedactedConnectScmResult(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new ConnectScmResult({
    result: fromRedactedConnectScmResult_result(msg.result, purpose, opts),
  });
}

function toRedactedConnectScmSuccess(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
  };
}

function fromRedactedConnectScmSuccess(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new ConnectScmSuccess({
  });
}

function toRedactedConnectScmToolCall(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    args: msg.args !== void 0 ? toRedactedConnectScmArgs(msg.args, privacyMode) : void 0,
    result: msg.result !== void 0 ? toRedactedConnectScmResult(msg.result, privacyMode) : void 0,
  };
}

function fromRedactedConnectScmToolCall(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new ConnectScmToolCall({
    args: msg.args !== void 0 ? fromRedactedConnectScmArgs(msg.args, purpose, opts) : void 0,
    result: msg.result !== void 0 ? fromRedactedConnectScmResult(msg.result, purpose, opts) : void 0,
  });
}

export {
  toRedactedConnectScmArgs,
  fromRedactedConnectScmArgs,
  toRedactedConnectScmArgs_target,
  fromRedactedConnectScmArgs_target,
  toRedactedConnectScmError,
  fromRedactedConnectScmError,
  toRedactedConnectScmGithub,
  fromRedactedConnectScmGithub,
  toRedactedConnectScmGithubRepository,
  fromRedactedConnectScmGithubRepository,
  toRedactedConnectScmRejected,
  fromRedactedConnectScmRejected,
  toRedactedConnectScmRequestQuery,
  fromRedactedConnectScmRequestQuery,
  toRedactedConnectScmRequestResponse,
  fromRedactedConnectScmRequestResponse,
  toRedactedConnectScmRequestResponse_result,
  fromRedactedConnectScmRequestResponse_result,
  toRedactedConnectScmRequestResponse_Approved,
  fromRedactedConnectScmRequestResponse_Approved,
  toRedactedConnectScmRequestResponse_Failed,
  fromRedactedConnectScmRequestResponse_Failed,
  toRedactedConnectScmRequestResponse_Rejected,
  fromRedactedConnectScmRequestResponse_Rejected,
  toRedactedConnectScmResult,
  fromRedactedConnectScmResult,
  toRedactedConnectScmResult_result,
  fromRedactedConnectScmResult_result,
  toRedactedConnectScmSuccess,
  fromRedactedConnectScmSuccess,
  toRedactedConnectScmToolCall,
  fromRedactedConnectScmToolCall,
};
