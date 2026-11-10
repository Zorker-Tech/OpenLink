// @ts-nocheck -- generated runtime: redaction changes a field's type structurally, so the
// declaration pass for these modules is a separate mechanical step.
//
// @generated from this repository's schema and redaction annotations. Do not edit.
//
// Regenerate with `pnpm --filter @slate/work-host redaction:generate`.
// Sensitive fields arrive as RedactedString/RedactedBytes; `fromRedacted*` asks for a purpose.
import { DataClassification } from "../../../../../../packages/redaction/classification.ts";
import { createRedactedString } from "../../../../../../packages/redaction/create.ts";
import { SetupVmEnvironmentArgs, SetupVmEnvironmentResult, SetupVmEnvironmentSuccess, SetupVmEnvironmentToolCall } from "../../../../proto/generated/agent/v1/setup_vm_environment_tool_pb.ts";

function toRedactedSetupVmEnvironmentArgs(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    installCommand: createRedactedString(msg.installCommand, DataClassification.CODE, "install_command", privacyMode),
    startCommand: createRedactedString(msg.startCommand, DataClassification.CODE, "start_command", privacyMode),
    dockerfileContents: createRedactedString(msg.dockerfileContents, DataClassification.CODE, "dockerfile_contents", privacyMode),
  };
}

function fromRedactedSetupVmEnvironmentArgs(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new SetupVmEnvironmentArgs({
    installCommand: msg.installCommand.unwrap(purpose, { redactUnallowedFieldsInsteadOfThrowing, enforcing }),
    startCommand: msg.startCommand.unwrap(purpose, { redactUnallowedFieldsInsteadOfThrowing, enforcing }),
    dockerfileContents: msg.dockerfileContents.unwrap(purpose, { redactUnallowedFieldsInsteadOfThrowing, enforcing }),
  });
}

function toRedactedSetupVmEnvironmentResult_result(oneof, privacyMode) {
  if (oneof === void 0) {
    return { case: void 0, value: void 0 };
  }
  switch (oneof.case) {
    case "success":
      return { case: "success", value: toRedactedSetupVmEnvironmentSuccess(oneof.value, privacyMode) };
    default:
      return { case: void 0, value: void 0 };
  }
}

function fromRedactedSetupVmEnvironmentResult_result(oneof, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  if (oneof === void 0) {
    return { case: void 0, value: void 0 };
  }
  switch (oneof.case) {
    case "success":
      return { case: "success", value: fromRedactedSetupVmEnvironmentSuccess(oneof.value, purpose, opts) };
    default:
      return { case: void 0, value: void 0 };
  }
}

function toRedactedSetupVmEnvironmentResult(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    result: toRedactedSetupVmEnvironmentResult_result(msg.result, privacyMode),
  };
}

function fromRedactedSetupVmEnvironmentResult(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new SetupVmEnvironmentResult({
    result: fromRedactedSetupVmEnvironmentResult_result(msg.result, purpose, opts),
  });
}

function toRedactedSetupVmEnvironmentSuccess(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
  };
}

function fromRedactedSetupVmEnvironmentSuccess(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new SetupVmEnvironmentSuccess({
  });
}

function toRedactedSetupVmEnvironmentToolCall(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    args: msg.args !== void 0 ? toRedactedSetupVmEnvironmentArgs(msg.args, privacyMode) : void 0,
    result: msg.result !== void 0 ? toRedactedSetupVmEnvironmentResult(msg.result, privacyMode) : void 0,
  };
}

function fromRedactedSetupVmEnvironmentToolCall(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new SetupVmEnvironmentToolCall({
    args: msg.args !== void 0 ? fromRedactedSetupVmEnvironmentArgs(msg.args, purpose, opts) : void 0,
    result: msg.result !== void 0 ? fromRedactedSetupVmEnvironmentResult(msg.result, purpose, opts) : void 0,
  });
}

export {
  toRedactedSetupVmEnvironmentArgs,
  fromRedactedSetupVmEnvironmentArgs,
  toRedactedSetupVmEnvironmentResult,
  fromRedactedSetupVmEnvironmentResult,
  toRedactedSetupVmEnvironmentResult_result,
  fromRedactedSetupVmEnvironmentResult_result,
  toRedactedSetupVmEnvironmentSuccess,
  fromRedactedSetupVmEnvironmentSuccess,
  toRedactedSetupVmEnvironmentToolCall,
  fromRedactedSetupVmEnvironmentToolCall,
};
