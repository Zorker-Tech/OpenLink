// @ts-nocheck -- generated runtime: redaction changes a field's type structurally, so the
// declaration pass for these modules is a separate mechanical step.
//
// @generated from this repository's schema and redaction annotations. Do not edit.
//
// Regenerate with `pnpm --filter @slate/work-host redaction:generate`.
// Sensitive fields arrive as RedactedString/RedactedBytes; `fromRedacted*` asks for a purpose.
import { CodeResult } from "../../../../proto/generated/aiserver/v1/repository_pb.ts";
import { CodeBlock } from "../../../../proto/generated/aiserver/v1/utils_pb.ts";
import { fromRedactedCodeBlock, toRedactedCodeBlock } from "./utils_redacted.ts";

function toRedactedCodeResult(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    codeBlock: msg.codeBlock !== void 0 ? toRedactedCodeBlock(msg.codeBlock, privacyMode) : void 0,
    score: msg.score,
  };
}

function fromRedactedCodeResult(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new CodeResult({
    codeBlock: msg.codeBlock !== void 0 ? fromRedactedCodeBlock(msg.codeBlock, purpose, opts) : void 0,
    score: msg.score,
  });
}

export {
  toRedactedCodeResult,
  fromRedactedCodeResult,
};
