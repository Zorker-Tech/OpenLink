// @ts-nocheck -- generated runtime: redaction changes a field's type structurally, so the
// declaration pass for these modules is a separate mechanical step.
//
// @generated from this repository's schema and redaction annotations. Do not edit.
//
// Regenerate with `pnpm --filter @slate/work-host redaction:generate`.
// Sensitive fields arrive as RedactedString/RedactedBytes; `fromRedacted*` asks for a purpose.
import { DataClassification } from "../../../../redaction/classification.ts";
import { createRedactedString } from "../../../../redaction/create.ts";
import { CursorRule, CursorRuleType, CursorRuleTypeAgentFetched, CursorRuleTypeFileGlobs, CursorRuleTypeGlobal, CursorRuleTypeManuallyAttached } from "../../../../proto/generated/agent/v1/rules_pb.ts";

function toRedactedCursorRule(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    fullPath: createRedactedString(msg.fullPath, DataClassification.PATH, "full_path", privacyMode),
    content: createRedactedString(msg.content, DataClassification.CODE, "content", privacyMode),
    type: msg.type !== void 0 ? toRedactedCursorRuleType(msg.type, privacyMode) : void 0,
    source: msg.source,
    gitRemoteOrigin: createRedactedString(msg.gitRemoteOrigin, DataClassification.PATH, "git_remote_origin", privacyMode),
    parseError: createRedactedString(msg.parseError, DataClassification.CODE, "parse_error", privacyMode),
    environments: msg.environments,
    disabledEnvironments: msg.disabledEnvironments,
    plugin: msg.plugin,
    marketplace: msg.marketplace,
    pluginId: msg.pluginId,
    marketplaceId: msg.marketplaceId,
    scopedTo: msg.scopedTo,
    frontmatter: createRedactedString(msg.frontmatter, DataClassification.CODE, "frontmatter", privacyMode),
    isRequired: msg.isRequired,
  };
}

function fromRedactedCursorRule(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new CursorRule({
    fullPath: msg.fullPath.unwrap(purpose, { redactUnallowedFieldsInsteadOfThrowing, enforcing }),
    content: msg.content.unwrap(purpose, { redactUnallowedFieldsInsteadOfThrowing, enforcing }),
    type: msg.type !== void 0 ? fromRedactedCursorRuleType(msg.type, purpose, opts) : void 0,
    source: msg.source,
    gitRemoteOrigin: msg.gitRemoteOrigin.unwrap(purpose, { redactUnallowedFieldsInsteadOfThrowing, enforcing }),
    parseError: msg.parseError.unwrap(purpose, { redactUnallowedFieldsInsteadOfThrowing, enforcing }),
    environments: msg.environments,
    disabledEnvironments: msg.disabledEnvironments,
    plugin: msg.plugin,
    marketplace: msg.marketplace,
    pluginId: msg.pluginId,
    marketplaceId: msg.marketplaceId,
    scopedTo: msg.scopedTo,
    frontmatter: msg.frontmatter.unwrap(purpose, { redactUnallowedFieldsInsteadOfThrowing, enforcing }),
    isRequired: msg.isRequired,
  });
}

function toRedactedCursorRuleType_type(oneof, privacyMode) {
  if (oneof === void 0) {
    return { case: void 0, value: void 0 };
  }
  switch (oneof.case) {
    case "global":
      return { case: "global", value: toRedactedCursorRuleTypeGlobal(oneof.value, privacyMode) };
    case "fileGlobbed":
      return { case: "fileGlobbed", value: toRedactedCursorRuleTypeFileGlobs(oneof.value, privacyMode) };
    case "agentFetched":
      return { case: "agentFetched", value: toRedactedCursorRuleTypeAgentFetched(oneof.value, privacyMode) };
    case "manuallyAttached":
      return { case: "manuallyAttached", value: toRedactedCursorRuleTypeManuallyAttached(oneof.value, privacyMode) };
    default:
      return { case: void 0, value: void 0 };
  }
}

function fromRedactedCursorRuleType_type(oneof, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  if (oneof === void 0) {
    return { case: void 0, value: void 0 };
  }
  switch (oneof.case) {
    case "global":
      return { case: "global", value: fromRedactedCursorRuleTypeGlobal(oneof.value, purpose, opts) };
    case "fileGlobbed":
      return { case: "fileGlobbed", value: fromRedactedCursorRuleTypeFileGlobs(oneof.value, purpose, opts) };
    case "agentFetched":
      return { case: "agentFetched", value: fromRedactedCursorRuleTypeAgentFetched(oneof.value, purpose, opts) };
    case "manuallyAttached":
      return { case: "manuallyAttached", value: fromRedactedCursorRuleTypeManuallyAttached(oneof.value, purpose, opts) };
    default:
      return { case: void 0, value: void 0 };
  }
}

function toRedactedCursorRuleType(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    type: toRedactedCursorRuleType_type(msg.type, privacyMode),
  };
}

function fromRedactedCursorRuleType(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new CursorRuleType({
    type: fromRedactedCursorRuleType_type(msg.type, purpose, opts),
  });
}

function toRedactedCursorRuleTypeAgentFetched(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    description: createRedactedString(msg.description, DataClassification.CODE, "description", privacyMode),
  };
}

function fromRedactedCursorRuleTypeAgentFetched(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new CursorRuleTypeAgentFetched({
    description: msg.description.unwrap(purpose, { redactUnallowedFieldsInsteadOfThrowing, enforcing }),
  });
}

function toRedactedCursorRuleTypeFileGlobs(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    globs: msg.globs.map((v2) => createRedactedString(v2, DataClassification.PATH, "globs", privacyMode)),
  };
}

function fromRedactedCursorRuleTypeFileGlobs(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new CursorRuleTypeFileGlobs({
    globs: msg.globs.map((v2) => v2.unwrap(purpose, { redactUnallowedFieldsInsteadOfThrowing, enforcing })),
  });
}

function toRedactedCursorRuleTypeGlobal(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
  };
}

function fromRedactedCursorRuleTypeGlobal(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new CursorRuleTypeGlobal({
  });
}

function toRedactedCursorRuleTypeManuallyAttached(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
  };
}

function fromRedactedCursorRuleTypeManuallyAttached(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new CursorRuleTypeManuallyAttached({
  });
}

export {
  toRedactedCursorRule,
  fromRedactedCursorRule,
  toRedactedCursorRuleType,
  fromRedactedCursorRuleType,
  toRedactedCursorRuleType_type,
  fromRedactedCursorRuleType_type,
  toRedactedCursorRuleTypeAgentFetched,
  fromRedactedCursorRuleTypeAgentFetched,
  toRedactedCursorRuleTypeFileGlobs,
  fromRedactedCursorRuleTypeFileGlobs,
  toRedactedCursorRuleTypeGlobal,
  fromRedactedCursorRuleTypeGlobal,
  toRedactedCursorRuleTypeManuallyAttached,
  fromRedactedCursorRuleTypeManuallyAttached,
};
