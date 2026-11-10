// @ts-nocheck -- generated runtime: redaction changes a field's type structurally, so the
// declaration pass for these modules is a separate mechanical step.
//
// @generated from this repository's schema and redaction annotations. Do not edit.
//
// Regenerate with `pnpm --filter @slate/work-host redaction:generate`.
// Sensitive fields arrive as RedactedString/RedactedBytes; `fromRedacted*` asks for a purpose.
import { ConversationSearchArgs, ConversationSearchResult } from "../../../../proto/generated/agent/v1/conversation_search_exec_pb.ts";
import { SearchConversationsToolCall } from "../../../../proto/generated/agent/v1/search_conversations_tool_pb.ts";
import { fromRedactedConversationSearchArgs, fromRedactedConversationSearchResult, toRedactedConversationSearchArgs, toRedactedConversationSearchResult } from "./conversation_search_exec_redacted.ts";

function toRedactedSearchConversationsToolCall(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    args: msg.args !== void 0 ? toRedactedConversationSearchArgs(msg.args, privacyMode) : void 0,
    result: msg.result !== void 0 ? toRedactedConversationSearchResult(msg.result, privacyMode) : void 0,
  };
}

function fromRedactedSearchConversationsToolCall(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new SearchConversationsToolCall({
    args: msg.args !== void 0 ? fromRedactedConversationSearchArgs(msg.args, purpose, opts) : void 0,
    result: msg.result !== void 0 ? fromRedactedConversationSearchResult(msg.result, purpose, opts) : void 0,
  });
}

export {
  toRedactedSearchConversationsToolCall,
  fromRedactedSearchConversationsToolCall,
};
