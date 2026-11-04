import { fromRedactedLsDirectoryTreeNode } from "../redacted-protos/generated/agent/v1/ls_exec_redacted.ts";
import type { PrivacyCapability } from "../../../packages/redaction/classification.ts";

/** Decodes a redacted wire tree only for the caller's explicit privacy capability. */
export function decodeRedactedDirectoryTree(value: unknown, purpose: PrivacyCapability): unknown {
  return fromRedactedLsDirectoryTreeNode(value as never, purpose, {});
}
