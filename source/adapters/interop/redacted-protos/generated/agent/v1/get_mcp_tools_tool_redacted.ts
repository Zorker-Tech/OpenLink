// @ts-nocheck -- generated runtime: redaction changes a field's type structurally, so the
// declaration pass for these modules is a separate mechanical step.
//
// @generated from this repository's schema and redaction annotations. Do not edit.
//
// Regenerate with `pnpm --filter @slate/work-host redaction:generate`.
// Sensitive fields arrive as RedactedString/RedactedBytes; `fromRedacted*` asks for a purpose.
import { DataClassification } from "../../../../../../packages/redaction/classification.ts";
import { createRedactedString } from "../../../../../../packages/redaction/create.ts";
import { GetMcpToolsAgentResult, GetMcpToolsArgs, GetMcpToolsError, GetMcpToolsSuccess, GetMcpToolsToolCall } from "../../../../proto/generated/agent/v1/get_mcp_tools_tool_pb.ts";

function toRedactedGetMcpToolsAgentResult_result(oneof, privacyMode) {
  if (oneof === void 0) {
    return { case: void 0, value: void 0 };
  }
  switch (oneof.case) {
    case "success":
      return { case: "success", value: toRedactedGetMcpToolsSuccess(oneof.value, privacyMode) };
    case "error":
      return { case: "error", value: toRedactedGetMcpToolsError(oneof.value, privacyMode) };
    default:
      return { case: void 0, value: void 0 };
  }
}

function fromRedactedGetMcpToolsAgentResult_result(oneof, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  if (oneof === void 0) {
    return { case: void 0, value: void 0 };
  }
  switch (oneof.case) {
    case "success":
      return { case: "success", value: fromRedactedGetMcpToolsSuccess(oneof.value, purpose, opts) };
    case "error":
      return { case: "error", value: fromRedactedGetMcpToolsError(oneof.value, purpose, opts) };
    default:
      return { case: void 0, value: void 0 };
  }
}

function toRedactedGetMcpToolsAgentResult(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    result: toRedactedGetMcpToolsAgentResult_result(msg.result, privacyMode),
  };
}

function fromRedactedGetMcpToolsAgentResult(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new GetMcpToolsAgentResult({
    result: fromRedactedGetMcpToolsAgentResult_result(msg.result, purpose, opts),
  });
}

function toRedactedGetMcpToolsArgs(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    server: msg.server,
    toolName: msg.toolName,
    pattern: msg.pattern,
    toolCallId: msg.toolCallId,
  };
}

function fromRedactedGetMcpToolsArgs(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new GetMcpToolsArgs({
    server: msg.server,
    toolName: msg.toolName,
    pattern: msg.pattern,
    toolCallId: msg.toolCallId,
  });
}

function toRedactedGetMcpToolsError(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    error: createRedactedString(msg.error, DataClassification.CODE, "error", privacyMode),
  };
}

function fromRedactedGetMcpToolsError(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new GetMcpToolsError({
    error: msg.error.unwrap(purpose, { redactUnallowedFieldsInsteadOfThrowing, enforcing }),
  });
}

function toRedactedGetMcpToolsSuccess(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    content: createRedactedString(msg.content, DataClassification.CODE, "content", privacyMode),
    outputFilePath: msg.outputFilePath !== void 0 ? createRedactedString(msg.outputFilePath, DataClassification.PATH, "output_file_path", privacyMode) : void 0,
  };
}

function fromRedactedGetMcpToolsSuccess(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new GetMcpToolsSuccess({
    content: msg.content.unwrap(purpose, { redactUnallowedFieldsInsteadOfThrowing, enforcing }),
    outputFilePath: msg.outputFilePath?.unwrap(purpose, { redactUnallowedFieldsInsteadOfThrowing, enforcing }),
  });
}

function toRedactedGetMcpToolsToolCall(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    args: msg.args !== void 0 ? toRedactedGetMcpToolsArgs(msg.args, privacyMode) : void 0,
    result: msg.result !== void 0 ? toRedactedGetMcpToolsAgentResult(msg.result, privacyMode) : void 0,
  };
}

function fromRedactedGetMcpToolsToolCall(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new GetMcpToolsToolCall({
    args: msg.args !== void 0 ? fromRedactedGetMcpToolsArgs(msg.args, purpose, opts) : void 0,
    result: msg.result !== void 0 ? fromRedactedGetMcpToolsAgentResult(msg.result, purpose, opts) : void 0,
  });
}

export {
  toRedactedGetMcpToolsAgentResult,
  fromRedactedGetMcpToolsAgentResult,
  toRedactedGetMcpToolsAgentResult_result,
  fromRedactedGetMcpToolsAgentResult_result,
  toRedactedGetMcpToolsArgs,
  fromRedactedGetMcpToolsArgs,
  toRedactedGetMcpToolsError,
  fromRedactedGetMcpToolsError,
  toRedactedGetMcpToolsSuccess,
  fromRedactedGetMcpToolsSuccess,
  toRedactedGetMcpToolsToolCall,
  fromRedactedGetMcpToolsToolCall,
};
