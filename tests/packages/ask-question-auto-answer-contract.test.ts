import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ASK_QUESTION_AUTO_ANSWER_MARKER,
  ASK_QUESTION_AUTO_ANSWER_REASON_BODY,
  ASK_QUESTION_AUTO_ANSWER_REASON_PREFIX,
  createAskQuestionAutoAnswerIdentity,
  formatAskQuestionAutoAnswerReason,
  isAskQuestionAutoAnswerReason,
  parseAskQuestionAutoAnswerIdentity,
} from "../../source/packages/constants/ask-question.ts";

describe("automatic answers to unanswered questions", () => {
  it("keeps the stored marker and legacy prefix stable", () => {
    assert.equal(ASK_QUESTION_AUTO_ANSWER_MARKER, "ask_question_auto_answer");
    assert.equal(ASK_QUESTION_AUTO_ANSWER_REASON_PREFIX, "No response was received within the time limit");
  });

  it("formats timeout and alternate automatic answers with their reason body", () => {
    assert.deepEqual(createAskQuestionAutoAnswerIdentity(), {
      marker: ASK_QUESTION_AUTO_ANSWER_MARKER,
      kind: "timeout",
    });
    const reason = formatAskQuestionAutoAnswerReason(createAskQuestionAutoAnswerIdentity("other"));
    assert.match(reason, new RegExp(`^${ASK_QUESTION_AUTO_ANSWER_MARKER}:other\\|`));
    assert.ok(reason.endsWith(ASK_QUESTION_AUTO_ANSWER_REASON_BODY));
  });

  it("recognizes only a complete supported marker and still reads legacy reasons", () => {
    const marked = formatAskQuestionAutoAnswerReason();
    assert.deepEqual(parseAskQuestionAutoAnswerIdentity(` ${marked} `), {
      marker: ASK_QUESTION_AUTO_ANSWER_MARKER,
      kind: "timeout",
    });
    assert.equal(parseAskQuestionAutoAnswerIdentity(`${ASK_QUESTION_AUTO_ANSWER_MARKER}:unknown|x`), undefined);
    assert.equal(parseAskQuestionAutoAnswerIdentity(`prefix ${marked}`), undefined);

    assert.equal(isAskQuestionAutoAnswerReason(marked), true);
    assert.equal(isAskQuestionAutoAnswerReason(`${ASK_QUESTION_AUTO_ANSWER_REASON_PREFIX}, then continue`), true);
    assert.equal(isAskQuestionAutoAnswerReason("a user wrote this"), false);
  });
});
