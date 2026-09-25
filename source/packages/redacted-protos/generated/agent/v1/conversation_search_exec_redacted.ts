// @ts-nocheck -- generated runtime: redaction changes a field's type structurally, so the
// declaration pass for these modules is a separate mechanical step.
//
// @generated from this repository's schema and redaction annotations. Do not edit.
//
// Regenerate with `pnpm --filter @slate/work-host redaction:generate`.
// Sensitive fields arrive as RedactedString/RedactedBytes; `fromRedacted*` asks for a purpose.
import { DataClassification } from "../../../../redaction/classification.ts";
import { createRedactedString } from "../../../../redaction/create.ts";
import { ConversationSearchArgs, ConversationSearchError, ConversationSearchHit, ConversationSearchResult, ConversationSearchSuccess } from "../../../../proto/generated/agent/v1/conversation_search_exec_pb.ts";

function toRedactedConversationSearchArgs(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    query: createRedactedString(msg.query, DataClassification.CODE, "query", privacyMode),
    toolCallId: msg.toolCallId,
    limit: msg.limit,
  };
}

function fromRedactedConversationSearchArgs(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new ConversationSearchArgs({
    query: msg.query.unwrap(purpose, { redactUnallowedFieldsInsteadOfThrowing, enforcing }),
    toolCallId: msg.toolCallId,
    limit: msg.limit,
  });
}

function toRedactedConversationSearchError(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    error: createRedactedString(msg.error, DataClassification.CODE, "error", privacyMode),
  };
}

function fromRedactedConversationSearchError(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new ConversationSearchError({
    error: msg.error.unwrap(purpose, { redactUnallowedFieldsInsteadOfThrowing, enforcing }),
  });
}

function toRedactedConversationSearchHit(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    conversationId: msg.conversationId,
    title: createRedactedString(msg.title, DataClassification.CODE, "title", privacyMode),
    source: msg.source,
    updatedAtMs: msg.updatedAtMs,
    snippet: createRedactedString(msg.snippet, DataClassification.CODE, "snippet", privacyMode),
  };
}

function fromRedactedConversationSearchHit(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new ConversationSearchHit({
    conversationId: msg.conversationId,
    title: msg.title.unwrap(purpose, { redactUnallowedFieldsInsteadOfThrowing, enforcing }),
    source: msg.source,
    updatedAtMs: msg.updatedAtMs,
    snippet: msg.snippet.unwrap(purpose, { redactUnallowedFieldsInsteadOfThrowing, enforcing }),
  });
}

function toRedactedConversationSearchResult_result(oneof, privacyMode) {
  if (oneof === void 0) {
    return { case: void 0, value: void 0 };
  }
  switch (oneof.case) {
    case "success":
      return { case: "success", value: toRedactedConversationSearchSuccess(oneof.value, privacyMode) };
    case "error":
      return { case: "error", value: toRedactedConversationSearchError(oneof.value, privacyMode) };
    default:
      return { case: void 0, value: void 0 };
  }
}

function fromRedactedConversationSearchResult_result(oneof, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  if (oneof === void 0) {
    return { case: void 0, value: void 0 };
  }
  switch (oneof.case) {
    case "success":
      return { case: "success", value: fromRedactedConversationSearchSuccess(oneof.value, purpose, opts) };
    case "error":
      return { case: "error", value: fromRedactedConversationSearchError(oneof.value, purpose, opts) };
    default:
      return { case: void 0, value: void 0 };
  }
}

function toRedactedConversationSearchResult(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    result: toRedactedConversationSearchResult_result(msg.result, privacyMode),
  };
}

function fromRedactedConversationSearchResult(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new ConversationSearchResult({
    result: fromRedactedConversationSearchResult_result(msg.result, purpose, opts),
  });
}

function toRedactedConversationSearchSuccess(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    hits: msg.hits.map((v2) => toRedactedConversationSearchHit(v2, privacyMode)),
    truncated: msg.truncated,
    partial: msg.partial,
    rebuilding: msg.rebuilding,
  };
}

function fromRedactedConversationSearchSuccess(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new ConversationSearchSuccess({
    hits: msg.hits.map((v2) => fromRedactedConversationSearchHit(v2, purpose, opts)),
    truncated: msg.truncated,
    partial: msg.partial,
    rebuilding: msg.rebuilding,
  });
}

export {
  toRedactedConversationSearchArgs,
  fromRedactedConversationSearchArgs,
  toRedactedConversationSearchError,
  fromRedactedConversationSearchError,
  toRedactedConversationSearchHit,
  fromRedactedConversationSearchHit,
  toRedactedConversationSearchResult,
  fromRedactedConversationSearchResult,
  toRedactedConversationSearchResult_result,
  fromRedactedConversationSearchResult_result,
  toRedactedConversationSearchSuccess,
  fromRedactedConversationSearchSuccess,
};
