// @ts-nocheck -- generated runtime: redaction changes a field's type structurally, so the
// declaration pass for these modules is a separate mechanical step.
//
// @generated from this repository's schema and redaction annotations. Do not edit.
//
// Regenerate with `pnpm --filter @slate/work-host redaction:generate`.
// Sensitive fields arrive as RedactedString/RedactedBytes; `fromRedacted*` asks for a purpose.
import { PiTruncation } from "../../../../proto/generated/agent/v1/pi_common_pb.ts";

function toRedactedPiTruncation(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    truncated: msg.truncated,
    truncatedBy: msg.truncatedBy,
    totalLines: msg.totalLines,
    outputLines: msg.outputLines,
    outputBytes: msg.outputBytes,
    maxLines: msg.maxLines,
    maxBytes: msg.maxBytes,
    firstLineExceedsLimit: msg.firstLineExceedsLimit,
    lastLinePartial: msg.lastLinePartial,
  };
}

function fromRedactedPiTruncation(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new PiTruncation({
    truncated: msg.truncated,
    truncatedBy: msg.truncatedBy,
    totalLines: msg.totalLines,
    outputLines: msg.outputLines,
    outputBytes: msg.outputBytes,
    maxLines: msg.maxLines,
    maxBytes: msg.maxBytes,
    firstLineExceedsLimit: msg.firstLineExceedsLimit,
    lastLinePartial: msg.lastLinePartial,
  });
}

export {
  toRedactedPiTruncation,
  fromRedactedPiTruncation,
};
