/** Slate-owned bounds for feedback content and attached error references. */
const FEEDBACK_LIMITS = {
  messageCharacters: 10_000,
  conversationIdCharacters: 512,
  accountSlotCharacters: 512,
  errorReferenceCount: 5,
  errorReferencePattern: /^[0-9a-f]{32}$/,
} as const;

export const SLATE_FEEDBACK_MESSAGE_MAX_CHARS = FEEDBACK_LIMITS.messageCharacters;
export const SLATE_FEEDBACK_CONVERSATION_ID_MAX_CHARS = FEEDBACK_LIMITS.conversationIdCharacters;
export const SLATE_FEEDBACK_ACCOUNT_SLOT_MAX_CHARS = FEEDBACK_LIMITS.accountSlotCharacters;
export const SLATE_FEEDBACK_ERROR_REFERENCE_ID_MAX_COUNT = FEEDBACK_LIMITS.errorReferenceCount;
export const SLATE_FEEDBACK_ERROR_REFERENCE_ID_PATTERN = FEEDBACK_LIMITS.errorReferencePattern;
