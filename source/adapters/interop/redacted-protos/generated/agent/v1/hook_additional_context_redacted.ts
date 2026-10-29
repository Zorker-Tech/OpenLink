// @ts-nocheck -- generated runtime: redaction changes a field's type structurally, so the
// declaration pass for these modules is a separate mechanical step.
//
// @generated from this repository's schema and redaction annotations. Do not edit.
//
// Regenerate with `pnpm --filter @slate/work-host redaction:generate`.
// Sensitive fields arrive as RedactedString/RedactedBytes; `fromRedacted*` asks for a purpose.
import { DataClassification } from "../../../../../../packages/redaction/classification.ts";
import { createRedactedString } from "../../../../../../packages/redaction/create.ts";
import { HookAdditionalContext } from "../../../../proto/generated/agent/v1/hook_additional_context_pb.ts";

function toRedactedHookAdditionalContext(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    hookEventName: msg.hookEventName,
    content: createRedactedString(msg.content, DataClassification.CODE, "content", privacyMode),
  };
}

function fromRedactedHookAdditionalContext(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new HookAdditionalContext({
    hookEventName: msg.hookEventName,
    content: msg.content.unwrap(purpose, { redactUnallowedFieldsInsteadOfThrowing, enforcing }),
  });
}

export {
  toRedactedHookAdditionalContext,
  fromRedactedHookAdditionalContext,
};
