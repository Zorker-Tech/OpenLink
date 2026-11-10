/** How a turn records that it continued after an unanswered question. */
export const ASK_QUESTION_AUTO_ANSWER_MARKER = "ask_question_auto_answer";

/** Stable prefix recognized in transcripts written before the marker format was introduced. */
export const ASK_QUESTION_AUTO_ANSWER_REASON_PREFIX = "No response was received within the time limit";

export const ASK_QUESTION_AUTO_ANSWER_REASON_BODY =
  `${ASK_QUESTION_AUTO_ANSWER_REASON_PREFIX}. Continue with a suggested choice where one was offered, and use the context already available for the rest.`;

const AUTO_ANSWER_KINDS = ["timeout", "other"] as const;
type AutoAnswerKind = (typeof AUTO_ANSWER_KINDS)[number];

export interface AskQuestionAutoAnswerIdentity {
  readonly marker: typeof ASK_QUESTION_AUTO_ANSWER_MARKER;
  readonly kind: AutoAnswerKind;
}

function isAutoAnswerKind(value: string): value is AutoAnswerKind {
  return AUTO_ANSWER_KINDS.includes(value as AutoAnswerKind);
}

export function createAskQuestionAutoAnswerIdentity(
  kind: AutoAnswerKind = "timeout",
): AskQuestionAutoAnswerIdentity {
  return { marker: ASK_QUESTION_AUTO_ANSWER_MARKER, kind };
}

function encodeIdentity(identity: AskQuestionAutoAnswerIdentity): string {
  return `${identity.marker}:${identity.kind}`;
}

export function formatAskQuestionAutoAnswerReason(
  identity: AskQuestionAutoAnswerIdentity = createAskQuestionAutoAnswerIdentity(),
): string {
  return `${encodeIdentity(identity)}|${ASK_QUESTION_AUTO_ANSWER_REASON_BODY}`;
}

export function parseAskQuestionAutoAnswerIdentity(
  reason: string | null | undefined,
): AskQuestionAutoAnswerIdentity | undefined {
  const normalized = (reason ?? "").trim();
  const prefix = `${ASK_QUESTION_AUTO_ANSWER_MARKER}:`;
  if (!normalized.startsWith(prefix)) return undefined;

  const kindEnd = normalized.indexOf("|", prefix.length);
  if (kindEnd < 0) return undefined;
  const kind = normalized.slice(prefix.length, kindEnd);
  return isAutoAnswerKind(kind) ? createAskQuestionAutoAnswerIdentity(kind) : undefined;
}

/** Also recognizes unmarked reasons already stored in older transcripts. */
export function isAskQuestionAutoAnswerReason(reason: string | null | undefined): boolean {
  const normalized = (reason ?? "").trim();
  return normalized.startsWith(ASK_QUESTION_AUTO_ANSWER_REASON_PREFIX) ||
    parseAskQuestionAutoAnswerIdentity(normalized) !== undefined;
}

export const ASK_QUESTION_AUTO_ANSWER_REASON = formatAskQuestionAutoAnswerReason();
