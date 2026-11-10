// @ts-nocheck -- generated runtime: redaction changes a field's type structurally, so the
// declaration pass for these modules is a separate mechanical step.
//
// @generated from this repository's schema and redaction annotations. Do not edit.
//
// Regenerate with `pnpm --filter @slate/work-host redaction:generate`.
// Sensitive fields arrive as RedactedString/RedactedBytes; `fromRedacted*` asks for a purpose.
import { DataClassification } from "../../../../../../packages/redaction/classification.ts";
import { createRedactedString } from "../../../../../../packages/redaction/create.ts";
import { ShellArgs, ShellResult } from "../../../../proto/generated/agent/v1/shell_exec_pb.ts";
import { ShellToolCall, ShellToolCallDelta, ShellToolCallStderrDelta, ShellToolCallStdoutDelta } from "../../../../proto/generated/agent/v1/shell_tool_pb.ts";
import { fromRedactedShellArgs, fromRedactedShellResult, toRedactedShellArgs, toRedactedShellResult } from "./shell_exec_redacted.ts";

function toRedactedShellToolCall(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    args: msg.args !== void 0 ? toRedactedShellArgs(msg.args, privacyMode) : void 0,
    result: msg.result !== void 0 ? toRedactedShellResult(msg.result, privacyMode) : void 0,
    description: msg.description,
  };
}

function fromRedactedShellToolCall(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new ShellToolCall({
    args: msg.args !== void 0 ? fromRedactedShellArgs(msg.args, purpose, opts) : void 0,
    result: msg.result !== void 0 ? fromRedactedShellResult(msg.result, purpose, opts) : void 0,
    description: msg.description,
  });
}

function toRedactedShellToolCallDelta_delta(oneof, privacyMode) {
  if (oneof === void 0) {
    return { case: void 0, value: void 0 };
  }
  switch (oneof.case) {
    case "stdout":
      return { case: "stdout", value: toRedactedShellToolCallStdoutDelta(oneof.value, privacyMode) };
    case "stderr":
      return { case: "stderr", value: toRedactedShellToolCallStderrDelta(oneof.value, privacyMode) };
    default:
      return { case: void 0, value: void 0 };
  }
}

function fromRedactedShellToolCallDelta_delta(oneof, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  if (oneof === void 0) {
    return { case: void 0, value: void 0 };
  }
  switch (oneof.case) {
    case "stdout":
      return { case: "stdout", value: fromRedactedShellToolCallStdoutDelta(oneof.value, purpose, opts) };
    case "stderr":
      return { case: "stderr", value: fromRedactedShellToolCallStderrDelta(oneof.value, purpose, opts) };
    default:
      return { case: void 0, value: void 0 };
  }
}

function toRedactedShellToolCallDelta(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    delta: toRedactedShellToolCallDelta_delta(msg.delta, privacyMode),
  };
}

function fromRedactedShellToolCallDelta(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new ShellToolCallDelta({
    delta: fromRedactedShellToolCallDelta_delta(msg.delta, purpose, opts),
  });
}

function toRedactedShellToolCallStderrDelta(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    content: createRedactedString(msg.content, DataClassification.CODE, "content", privacyMode),
  };
}

function fromRedactedShellToolCallStderrDelta(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new ShellToolCallStderrDelta({
    content: msg.content.unwrap(purpose, { redactUnallowedFieldsInsteadOfThrowing, enforcing }),
  });
}

function toRedactedShellToolCallStdoutDelta(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    content: createRedactedString(msg.content, DataClassification.CODE, "content", privacyMode),
  };
}

function fromRedactedShellToolCallStdoutDelta(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new ShellToolCallStdoutDelta({
    content: msg.content.unwrap(purpose, { redactUnallowedFieldsInsteadOfThrowing, enforcing }),
  });
}

export {
  toRedactedShellToolCall,
  fromRedactedShellToolCall,
  toRedactedShellToolCallDelta,
  fromRedactedShellToolCallDelta,
  toRedactedShellToolCallDelta_delta,
  fromRedactedShellToolCallDelta_delta,
  toRedactedShellToolCallStderrDelta,
  fromRedactedShellToolCallStderrDelta,
  toRedactedShellToolCallStdoutDelta,
  fromRedactedShellToolCallStdoutDelta,
};
