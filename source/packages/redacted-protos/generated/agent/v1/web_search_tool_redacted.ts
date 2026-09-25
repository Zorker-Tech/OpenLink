// @ts-nocheck -- generated runtime: redaction changes a field's type structurally, so the
// declaration pass for these modules is a separate mechanical step.
//
// @generated from this repository's schema and redaction annotations. Do not edit.
//
// Regenerate with `pnpm --filter @slate/work-host redaction:generate`.
// Sensitive fields arrive as RedactedString/RedactedBytes; `fromRedacted*` asks for a purpose.
import { DataClassification } from "../../../../redaction/classification.ts";
import { createRedactedString } from "../../../../redaction/create.ts";
import { WebSearchArgs, WebSearchError, WebSearchReference, WebSearchRejected, WebSearchRequestQuery, WebSearchRequestResponse, WebSearchRequestResponse_Approved, WebSearchRequestResponse_Rejected, WebSearchResult, WebSearchSuccess, WebSearchToolCall } from "../../../../proto/generated/agent/v1/web_search_tool_pb.ts";

function toRedactedWebSearchArgs(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    searchTerm: createRedactedString(msg.searchTerm, DataClassification.CODE, "search_term", privacyMode),
    toolCallId: msg.toolCallId,
  };
}

function fromRedactedWebSearchArgs(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new WebSearchArgs({
    searchTerm: msg.searchTerm.unwrap(purpose, { redactUnallowedFieldsInsteadOfThrowing, enforcing }),
    toolCallId: msg.toolCallId,
  });
}

function toRedactedWebSearchError(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    error: createRedactedString(msg.error, DataClassification.CODE, "error", privacyMode),
  };
}

function fromRedactedWebSearchError(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new WebSearchError({
    error: msg.error.unwrap(purpose, { redactUnallowedFieldsInsteadOfThrowing, enforcing }),
  });
}

function toRedactedWebSearchReference(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    title: createRedactedString(msg.title, DataClassification.CODE, "title", privacyMode),
    url: msg.url,
    chunk: createRedactedString(msg.chunk, DataClassification.CODE, "chunk", privacyMode),
  };
}

function fromRedactedWebSearchReference(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new WebSearchReference({
    title: msg.title.unwrap(purpose, { redactUnallowedFieldsInsteadOfThrowing, enforcing }),
    url: msg.url,
    chunk: msg.chunk.unwrap(purpose, { redactUnallowedFieldsInsteadOfThrowing, enforcing }),
  });
}

function toRedactedWebSearchRejected(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    reason: createRedactedString(msg.reason, DataClassification.CODE, "reason", privacyMode),
  };
}

function fromRedactedWebSearchRejected(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new WebSearchRejected({
    reason: msg.reason.unwrap(purpose, { redactUnallowedFieldsInsteadOfThrowing, enforcing }),
  });
}

function toRedactedWebSearchRequestQuery(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    args: msg.args !== void 0 ? toRedactedWebSearchArgs(msg.args, privacyMode) : void 0,
  };
}

function fromRedactedWebSearchRequestQuery(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new WebSearchRequestQuery({
    args: msg.args !== void 0 ? fromRedactedWebSearchArgs(msg.args, purpose, opts) : void 0,
  });
}

function toRedactedWebSearchRequestResponse_result(oneof, privacyMode) {
  if (oneof === void 0) {
    return { case: void 0, value: void 0 };
  }
  switch (oneof.case) {
    case "approved":
      return { case: "approved", value: toRedactedWebSearchRequestResponse_Approved(oneof.value, privacyMode) };
    case "rejected":
      return { case: "rejected", value: toRedactedWebSearchRequestResponse_Rejected(oneof.value, privacyMode) };
    default:
      return { case: void 0, value: void 0 };
  }
}

function fromRedactedWebSearchRequestResponse_result(oneof, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  if (oneof === void 0) {
    return { case: void 0, value: void 0 };
  }
  switch (oneof.case) {
    case "approved":
      return { case: "approved", value: fromRedactedWebSearchRequestResponse_Approved(oneof.value, purpose, opts) };
    case "rejected":
      return { case: "rejected", value: fromRedactedWebSearchRequestResponse_Rejected(oneof.value, purpose, opts) };
    default:
      return { case: void 0, value: void 0 };
  }
}

function toRedactedWebSearchRequestResponse(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    result: toRedactedWebSearchRequestResponse_result(msg.result, privacyMode),
  };
}

function fromRedactedWebSearchRequestResponse(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new WebSearchRequestResponse({
    result: fromRedactedWebSearchRequestResponse_result(msg.result, purpose, opts),
  });
}

function toRedactedWebSearchRequestResponse_Approved(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
  };
}

function fromRedactedWebSearchRequestResponse_Approved(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new WebSearchRequestResponse_Approved({
  });
}

function toRedactedWebSearchRequestResponse_Rejected(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    reason: createRedactedString(msg.reason, DataClassification.CODE, "reason", privacyMode),
  };
}

function fromRedactedWebSearchRequestResponse_Rejected(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new WebSearchRequestResponse_Rejected({
    reason: msg.reason.unwrap(purpose, { redactUnallowedFieldsInsteadOfThrowing, enforcing }),
  });
}

function toRedactedWebSearchResult_result(oneof, privacyMode) {
  if (oneof === void 0) {
    return { case: void 0, value: void 0 };
  }
  switch (oneof.case) {
    case "success":
      return { case: "success", value: toRedactedWebSearchSuccess(oneof.value, privacyMode) };
    case "error":
      return { case: "error", value: toRedactedWebSearchError(oneof.value, privacyMode) };
    case "rejected":
      return { case: "rejected", value: toRedactedWebSearchRejected(oneof.value, privacyMode) };
    default:
      return { case: void 0, value: void 0 };
  }
}

function fromRedactedWebSearchResult_result(oneof, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  if (oneof === void 0) {
    return { case: void 0, value: void 0 };
  }
  switch (oneof.case) {
    case "success":
      return { case: "success", value: fromRedactedWebSearchSuccess(oneof.value, purpose, opts) };
    case "error":
      return { case: "error", value: fromRedactedWebSearchError(oneof.value, purpose, opts) };
    case "rejected":
      return { case: "rejected", value: fromRedactedWebSearchRejected(oneof.value, purpose, opts) };
    default:
      return { case: void 0, value: void 0 };
  }
}

function toRedactedWebSearchResult(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    result: toRedactedWebSearchResult_result(msg.result, privacyMode),
  };
}

function fromRedactedWebSearchResult(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new WebSearchResult({
    result: fromRedactedWebSearchResult_result(msg.result, purpose, opts),
  });
}

function toRedactedWebSearchSuccess(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    references: msg.references.map((v2) => toRedactedWebSearchReference(v2, privacyMode)),
  };
}

function fromRedactedWebSearchSuccess(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new WebSearchSuccess({
    references: msg.references.map((v2) => fromRedactedWebSearchReference(v2, purpose, opts)),
  });
}

function toRedactedWebSearchToolCall(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    args: msg.args !== void 0 ? toRedactedWebSearchArgs(msg.args, privacyMode) : void 0,
    result: msg.result !== void 0 ? toRedactedWebSearchResult(msg.result, privacyMode) : void 0,
  };
}

function fromRedactedWebSearchToolCall(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new WebSearchToolCall({
    args: msg.args !== void 0 ? fromRedactedWebSearchArgs(msg.args, purpose, opts) : void 0,
    result: msg.result !== void 0 ? fromRedactedWebSearchResult(msg.result, purpose, opts) : void 0,
  });
}

export {
  toRedactedWebSearchArgs,
  fromRedactedWebSearchArgs,
  toRedactedWebSearchError,
  fromRedactedWebSearchError,
  toRedactedWebSearchReference,
  fromRedactedWebSearchReference,
  toRedactedWebSearchRejected,
  fromRedactedWebSearchRejected,
  toRedactedWebSearchRequestQuery,
  fromRedactedWebSearchRequestQuery,
  toRedactedWebSearchRequestResponse,
  fromRedactedWebSearchRequestResponse,
  toRedactedWebSearchRequestResponse_result,
  fromRedactedWebSearchRequestResponse_result,
  toRedactedWebSearchRequestResponse_Approved,
  fromRedactedWebSearchRequestResponse_Approved,
  toRedactedWebSearchRequestResponse_Rejected,
  fromRedactedWebSearchRequestResponse_Rejected,
  toRedactedWebSearchResult,
  fromRedactedWebSearchResult,
  toRedactedWebSearchResult_result,
  fromRedactedWebSearchResult_result,
  toRedactedWebSearchSuccess,
  fromRedactedWebSearchSuccess,
  toRedactedWebSearchToolCall,
  fromRedactedWebSearchToolCall,
};
