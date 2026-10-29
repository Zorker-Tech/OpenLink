// @ts-nocheck -- generated runtime: redaction changes a field's type structurally, so the
// declaration pass for these modules is a separate mechanical step.
//
// @generated from this repository's schema and redaction annotations. Do not edit.
//
// Regenerate with `pnpm --filter @slate/work-host redaction:generate`.
// Sensitive fields arrive as RedactedString/RedactedBytes; `fromRedacted*` asks for a purpose.
import { DataClassification } from "../../../../../../packages/redaction/classification.ts";
import { createRedactedString } from "../../../../../../packages/redaction/create.ts";
import { SystemPromptSpec } from "../../../../proto/generated/agent/v1/system_prompt_pb.ts";

function toRedactedSystemPromptSpec_spec(oneof, privacyMode) {
  if (oneof === void 0) {
    return { case: void 0, value: void 0 };
  }
  switch (oneof.case) {
    case "replace":
      return { case: "replace", value: createRedactedString(oneof.value, DataClassification.CODE, "replace", privacyMode) };
    case "append":
      return { case: "append", value: createRedactedString(oneof.value, DataClassification.CODE, "append", privacyMode) };
    default:
      return { case: void 0, value: void 0 };
  }
}

function fromRedactedSystemPromptSpec_spec(oneof, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  if (oneof === void 0) {
    return { case: void 0, value: void 0 };
  }
  switch (oneof.case) {
    case "replace":
      return { case: "replace", value: oneof.value.unwrap(purpose, { redactUnallowedFieldsInsteadOfThrowing, enforcing }) };
    case "append":
      return { case: "append", value: oneof.value.unwrap(purpose, { redactUnallowedFieldsInsteadOfThrowing, enforcing }) };
    default:
      return { case: void 0, value: void 0 };
  }
}

function toRedactedSystemPromptSpec(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    spec: toRedactedSystemPromptSpec_spec(msg.spec, privacyMode),
  };
}

function fromRedactedSystemPromptSpec(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new SystemPromptSpec({
    spec: fromRedactedSystemPromptSpec_spec(msg.spec, purpose, opts),
  });
}

export {
  toRedactedSystemPromptSpec,
  fromRedactedSystemPromptSpec,
  toRedactedSystemPromptSpec_spec,
  fromRedactedSystemPromptSpec_spec,
};
