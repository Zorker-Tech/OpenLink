// @ts-nocheck -- generated runtime: redaction changes a field's type structurally, so the
// declaration pass for these modules is a separate mechanical step.
//
// @generated from this repository's schema and redaction annotations. Do not edit.
//
// Regenerate with `pnpm --filter @slate/work-host redaction:generate`.
// Sensitive fields arrive as RedactedString/RedactedBytes; `fromRedacted*` asks for a purpose.
import { DataClassification } from "../../../../redaction/classification.ts";
import { createRedactedString } from "../../../../redaction/create.ts";
import { CreatePlanArgs, CreatePlanError, CreatePlanRequestQuery, CreatePlanRequestResponse, CreatePlanResult, CreatePlanSuccess, CreatePlanToolCall, Phase } from "../../../../proto/generated/agent/v1/create_plan_tool_pb.ts";
import { TodoItem } from "../../../../proto/generated/agent/v1/todo_tool_pb.ts";
import { fromRedactedTodoItem, toRedactedTodoItem } from "./todo_tool_redacted.ts";

function toRedactedCreatePlanArgs(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    plan: createRedactedString(msg.plan, DataClassification.CODE, "plan", privacyMode),
    todos: msg.todos.map((v2) => toRedactedTodoItem(v2, privacyMode)),
    overview: createRedactedString(msg.overview, DataClassification.CODE, "overview", privacyMode),
    name: createRedactedString(msg.name, DataClassification.CODE, "name", privacyMode),
    isProject: msg.isProject,
    phases: msg.phases.map((v2) => toRedactedPhase(v2, privacyMode)),
  };
}

function fromRedactedCreatePlanArgs(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new CreatePlanArgs({
    plan: msg.plan.unwrap(purpose, { redactUnallowedFieldsInsteadOfThrowing, enforcing }),
    todos: msg.todos.map((v2) => fromRedactedTodoItem(v2, purpose, opts)),
    overview: msg.overview.unwrap(purpose, { redactUnallowedFieldsInsteadOfThrowing, enforcing }),
    name: msg.name.unwrap(purpose, { redactUnallowedFieldsInsteadOfThrowing, enforcing }),
    isProject: msg.isProject,
    phases: msg.phases.map((v2) => fromRedactedPhase(v2, purpose, opts)),
  });
}

function toRedactedCreatePlanError(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    error: createRedactedString(msg.error, DataClassification.CODE, "error", privacyMode),
  };
}

function fromRedactedCreatePlanError(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new CreatePlanError({
    error: msg.error.unwrap(purpose, { redactUnallowedFieldsInsteadOfThrowing, enforcing }),
  });
}

function toRedactedCreatePlanRequestQuery(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    args: msg.args !== void 0 ? toRedactedCreatePlanArgs(msg.args, privacyMode) : void 0,
    toolCallId: msg.toolCallId,
  };
}

function fromRedactedCreatePlanRequestQuery(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new CreatePlanRequestQuery({
    args: msg.args !== void 0 ? fromRedactedCreatePlanArgs(msg.args, purpose, opts) : void 0,
    toolCallId: msg.toolCallId,
  });
}

function toRedactedCreatePlanRequestResponse(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    result: msg.result !== void 0 ? toRedactedCreatePlanResult(msg.result, privacyMode) : void 0,
  };
}

function fromRedactedCreatePlanRequestResponse(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new CreatePlanRequestResponse({
    result: msg.result !== void 0 ? fromRedactedCreatePlanResult(msg.result, purpose, opts) : void 0,
  });
}

function toRedactedCreatePlanResult_result(oneof, privacyMode) {
  if (oneof === void 0) {
    return { case: void 0, value: void 0 };
  }
  switch (oneof.case) {
    case "success":
      return { case: "success", value: toRedactedCreatePlanSuccess(oneof.value, privacyMode) };
    case "error":
      return { case: "error", value: toRedactedCreatePlanError(oneof.value, privacyMode) };
    default:
      return { case: void 0, value: void 0 };
  }
}

function fromRedactedCreatePlanResult_result(oneof, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  if (oneof === void 0) {
    return { case: void 0, value: void 0 };
  }
  switch (oneof.case) {
    case "success":
      return { case: "success", value: fromRedactedCreatePlanSuccess(oneof.value, purpose, opts) };
    case "error":
      return { case: "error", value: fromRedactedCreatePlanError(oneof.value, purpose, opts) };
    default:
      return { case: void 0, value: void 0 };
  }
}

function toRedactedCreatePlanResult(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    planUri: createRedactedString(msg.planUri, DataClassification.PATH, "plan_uri", privacyMode),
    result: toRedactedCreatePlanResult_result(msg.result, privacyMode),
  };
}

function fromRedactedCreatePlanResult(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new CreatePlanResult({
    planUri: msg.planUri.unwrap(purpose, { redactUnallowedFieldsInsteadOfThrowing, enforcing }),
    result: fromRedactedCreatePlanResult_result(msg.result, purpose, opts),
  });
}

function toRedactedCreatePlanSuccess(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
  };
}

function fromRedactedCreatePlanSuccess(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new CreatePlanSuccess({
  });
}

function toRedactedCreatePlanToolCall(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    args: msg.args !== void 0 ? toRedactedCreatePlanArgs(msg.args, privacyMode) : void 0,
    result: msg.result !== void 0 ? toRedactedCreatePlanResult(msg.result, privacyMode) : void 0,
  };
}

function fromRedactedCreatePlanToolCall(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new CreatePlanToolCall({
    args: msg.args !== void 0 ? fromRedactedCreatePlanArgs(msg.args, purpose, opts) : void 0,
    result: msg.result !== void 0 ? fromRedactedCreatePlanResult(msg.result, purpose, opts) : void 0,
  });
}

function toRedactedPhase(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    name: createRedactedString(msg.name, DataClassification.CODE, "name", privacyMode),
    todos: msg.todos.map((v2) => toRedactedTodoItem(v2, privacyMode)),
  };
}

function fromRedactedPhase(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new Phase({
    name: msg.name.unwrap(purpose, { redactUnallowedFieldsInsteadOfThrowing, enforcing }),
    todos: msg.todos.map((v2) => fromRedactedTodoItem(v2, purpose, opts)),
  });
}

export {
  toRedactedCreatePlanArgs,
  fromRedactedCreatePlanArgs,
  toRedactedCreatePlanError,
  fromRedactedCreatePlanError,
  toRedactedCreatePlanRequestQuery,
  fromRedactedCreatePlanRequestQuery,
  toRedactedCreatePlanRequestResponse,
  fromRedactedCreatePlanRequestResponse,
  toRedactedCreatePlanResult,
  fromRedactedCreatePlanResult,
  toRedactedCreatePlanResult_result,
  fromRedactedCreatePlanResult_result,
  toRedactedCreatePlanSuccess,
  fromRedactedCreatePlanSuccess,
  toRedactedCreatePlanToolCall,
  fromRedactedCreatePlanToolCall,
  toRedactedPhase,
  fromRedactedPhase,
};
