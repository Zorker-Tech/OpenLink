import type { SkillAttachmentSelection, SkillAttachmentSource } from "../../../packages/agent/skill-attachment-contracts.ts";

type StringDecoder = (value: unknown) => string | undefined;

const plainString: StringDecoder = (value) => typeof value === "string" ? value : undefined;

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function readAttachment(value: unknown, decode: StringDecoder): SkillAttachmentSource {
  const fields = recordOf(value) ?? {};
  return {
    path: decode(fields.fullPath) ?? "",
    text: decode(fields.content) ?? "",
    pluginName: decode(fields.plugin),
    marketplaceName: decode(fields.marketplace),
    pluginId: decode(fields.pluginId),
    marketplaceId: decode(fields.marketplaceId),
  };
}

/** Converts the counterpart's selected-context message into the host's attachment-selection model. */
export function decodeSelectedContextSkillAttachments(
  selectedContext: unknown,
  decodeString: StringDecoder = plainString,
): SkillAttachmentSelection {
  const fields = recordOf(selectedContext) ?? {};
  const direct = Array.isArray(fields.selectedSkills) ? fields.selectedSkills : [];
  const ruleRows = Array.isArray(fields.cursorRules) ? fields.cursorRules : [];
  return {
    explicitSkills: direct.map((skill) => readAttachment(skill, decodeString)),
    ruleCandidates: ruleRows.map((row) => {
      const rule = recordOf(row)?.rule;
      return rule === undefined ? undefined : readAttachment(rule, decodeString);
    }),
  };
}
