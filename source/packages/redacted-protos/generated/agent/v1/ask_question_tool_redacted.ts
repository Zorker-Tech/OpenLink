// @ts-nocheck -- generated runtime: redaction changes a field's type structurally, so the
// declaration pass for these modules is a separate mechanical step.
//
// @generated from this repository's schema and redaction annotations. Do not edit.
//
// Regenerate with `pnpm --filter @slate/work-host redaction:generate`.
// Sensitive fields arrive as RedactedString/RedactedBytes; `fromRedacted*` asks for a purpose.
import { DataClassification } from "../../../../redaction/classification.ts";
import { createRedactedString } from "../../../../redaction/create.ts";
import { AskQuestionArgs, AskQuestionArgs_Option, AskQuestionArgs_Question, AskQuestionAsync, AskQuestionError, AskQuestionRejected, AskQuestionResult, AskQuestionSuccess, AskQuestionSuccess_Answer, AskQuestionToolCall } from "../../../../proto/generated/agent/v1/ask_question_tool_pb.ts";

function toRedactedAskQuestionArgs(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    title: createRedactedString(msg.title, DataClassification.CODE, "title", privacyMode),
    questions: msg.questions.map((v2) => toRedactedAskQuestionArgs_Question(v2, privacyMode)),
    runAsync: msg.runAsync,
    asyncOriginalToolCallId: msg.asyncOriginalToolCallId,
  };
}

function fromRedactedAskQuestionArgs(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new AskQuestionArgs({
    title: msg.title.unwrap(purpose, { redactUnallowedFieldsInsteadOfThrowing, enforcing }),
    questions: msg.questions.map((v2) => fromRedactedAskQuestionArgs_Question(v2, purpose, opts)),
    runAsync: msg.runAsync,
    asyncOriginalToolCallId: msg.asyncOriginalToolCallId,
  });
}

function toRedactedAskQuestionArgs_Option(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    id: msg.id,
    label: createRedactedString(msg.label, DataClassification.CODE, "label", privacyMode),
  };
}

function fromRedactedAskQuestionArgs_Option(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new AskQuestionArgs_Option({
    id: msg.id,
    label: msg.label.unwrap(purpose, { redactUnallowedFieldsInsteadOfThrowing, enforcing }),
  });
}

function toRedactedAskQuestionArgs_Question(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    id: msg.id,
    prompt: createRedactedString(msg.prompt, DataClassification.CODE, "prompt", privacyMode),
    options: msg.options.map((v2) => toRedactedAskQuestionArgs_Option(v2, privacyMode)),
    allowMultiple: msg.allowMultiple,
  };
}

function fromRedactedAskQuestionArgs_Question(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new AskQuestionArgs_Question({
    id: msg.id,
    prompt: msg.prompt.unwrap(purpose, { redactUnallowedFieldsInsteadOfThrowing, enforcing }),
    options: msg.options.map((v2) => fromRedactedAskQuestionArgs_Option(v2, purpose, opts)),
    allowMultiple: msg.allowMultiple,
  });
}

function toRedactedAskQuestionAsync(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
  };
}

function fromRedactedAskQuestionAsync(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new AskQuestionAsync({
  });
}

function toRedactedAskQuestionError(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    errorMessage: createRedactedString(msg.errorMessage, DataClassification.CODE, "error_message", privacyMode),
  };
}

function fromRedactedAskQuestionError(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new AskQuestionError({
    errorMessage: msg.errorMessage.unwrap(purpose, { redactUnallowedFieldsInsteadOfThrowing, enforcing }),
  });
}

function toRedactedAskQuestionRejected(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    reason: createRedactedString(msg.reason, DataClassification.CODE, "reason", privacyMode),
  };
}

function fromRedactedAskQuestionRejected(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new AskQuestionRejected({
    reason: msg.reason.unwrap(purpose, { redactUnallowedFieldsInsteadOfThrowing, enforcing }),
  });
}

function toRedactedAskQuestionResult_result(oneof, privacyMode) {
  if (oneof === void 0) {
    return { case: void 0, value: void 0 };
  }
  switch (oneof.case) {
    case "success":
      return { case: "success", value: toRedactedAskQuestionSuccess(oneof.value, privacyMode) };
    case "error":
      return { case: "error", value: toRedactedAskQuestionError(oneof.value, privacyMode) };
    case "rejected":
      return { case: "rejected", value: toRedactedAskQuestionRejected(oneof.value, privacyMode) };
    case "async":
      return { case: "async", value: toRedactedAskQuestionAsync(oneof.value, privacyMode) };
    default:
      return { case: void 0, value: void 0 };
  }
}

function fromRedactedAskQuestionResult_result(oneof, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  if (oneof === void 0) {
    return { case: void 0, value: void 0 };
  }
  switch (oneof.case) {
    case "success":
      return { case: "success", value: fromRedactedAskQuestionSuccess(oneof.value, purpose, opts) };
    case "error":
      return { case: "error", value: fromRedactedAskQuestionError(oneof.value, purpose, opts) };
    case "rejected":
      return { case: "rejected", value: fromRedactedAskQuestionRejected(oneof.value, purpose, opts) };
    case "async":
      return { case: "async", value: fromRedactedAskQuestionAsync(oneof.value, purpose, opts) };
    default:
      return { case: void 0, value: void 0 };
  }
}

function toRedactedAskQuestionResult(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    result: toRedactedAskQuestionResult_result(msg.result, privacyMode),
  };
}

function fromRedactedAskQuestionResult(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new AskQuestionResult({
    result: fromRedactedAskQuestionResult_result(msg.result, purpose, opts),
  });
}

function toRedactedAskQuestionSuccess(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    answers: msg.answers.map((v2) => toRedactedAskQuestionSuccess_Answer(v2, privacyMode)),
  };
}

function fromRedactedAskQuestionSuccess(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new AskQuestionSuccess({
    answers: msg.answers.map((v2) => fromRedactedAskQuestionSuccess_Answer(v2, purpose, opts)),
  });
}

function toRedactedAskQuestionSuccess_Answer(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    questionId: msg.questionId,
    selectedOptionIds: msg.selectedOptionIds,
    freeformText: createRedactedString(msg.freeformText, DataClassification.CODE, "freeform_text", privacyMode),
  };
}

function fromRedactedAskQuestionSuccess_Answer(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new AskQuestionSuccess_Answer({
    questionId: msg.questionId,
    selectedOptionIds: msg.selectedOptionIds,
    freeformText: msg.freeformText.unwrap(purpose, { redactUnallowedFieldsInsteadOfThrowing, enforcing }),
  });
}

function toRedactedAskQuestionToolCall(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    args: msg.args !== void 0 ? toRedactedAskQuestionArgs(msg.args, privacyMode) : void 0,
    result: msg.result !== void 0 ? toRedactedAskQuestionResult(msg.result, privacyMode) : void 0,
  };
}

function fromRedactedAskQuestionToolCall(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new AskQuestionToolCall({
    args: msg.args !== void 0 ? fromRedactedAskQuestionArgs(msg.args, purpose, opts) : void 0,
    result: msg.result !== void 0 ? fromRedactedAskQuestionResult(msg.result, purpose, opts) : void 0,
  });
}

export {
  toRedactedAskQuestionArgs,
  fromRedactedAskQuestionArgs,
  toRedactedAskQuestionArgs_Option,
  fromRedactedAskQuestionArgs_Option,
  toRedactedAskQuestionArgs_Question,
  fromRedactedAskQuestionArgs_Question,
  toRedactedAskQuestionAsync,
  fromRedactedAskQuestionAsync,
  toRedactedAskQuestionError,
  fromRedactedAskQuestionError,
  toRedactedAskQuestionRejected,
  fromRedactedAskQuestionRejected,
  toRedactedAskQuestionResult,
  fromRedactedAskQuestionResult,
  toRedactedAskQuestionResult_result,
  fromRedactedAskQuestionResult_result,
  toRedactedAskQuestionSuccess,
  fromRedactedAskQuestionSuccess,
  toRedactedAskQuestionSuccess_Answer,
  fromRedactedAskQuestionSuccess_Answer,
  toRedactedAskQuestionToolCall,
  fromRedactedAskQuestionToolCall,
};
