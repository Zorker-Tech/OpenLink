import type {
  AttachedRule,
  AttachedSkill,
  ResolvedSkillAttachments,
  SkillAttachmentSelection,
  SkillAttachmentSource,
} from "./skill-attachment-contracts.ts";

function hasSkillDocumentPath(path: string | undefined): boolean {
  if (!path) return false;
  const normalized = path.replace(/\\/g, "/");
  return normalized === "SKILL.md" || normalized.endsWith("/SKILL.md");
}

function isUsefulAttachment(source: SkillAttachmentSource | undefined): source is SkillAttachmentSource & { readonly text: string } {
  return source?.text !== undefined && source.text.trim().length > 0;
}

function toAttachedSkill(source: SkillAttachmentSource): AttachedSkill {
  return {
    path: source.path ?? "",
    text: source.text ?? "",
    pluginName: source.pluginName,
    marketplaceName: source.marketplaceName,
    pluginId: source.pluginId,
    marketplaceId: source.marketplaceId,
  };
}

function toAttachedRule(source: SkillAttachmentSource): AttachedRule {
  return {
    ...(source.path === undefined ? {} : { path: source.path }),
    ...(source.text === undefined ? {} : { text: source.text }),
    ...(source.pluginName === undefined ? {} : { pluginName: source.pluginName }),
    ...(source.marketplaceName === undefined ? {} : { marketplaceName: source.marketplaceName }),
    ...(source.pluginId === undefined ? {} : { pluginId: source.pluginId }),
    ...(source.marketplaceId === undefined ? {} : { marketplaceId: source.marketplaceId }),
  };
}

export function resolveSkillAttachments(input: SkillAttachmentSelection): ResolvedSkillAttachments {
  const usableRules = (input.ruleCandidates ?? []).filter(isUsefulAttachment);
  const hasExplicitSkills = (input.explicitSkills?.length ?? 0) > 0;
  const skills = hasExplicitSkills
    ? (input.explicitSkills ?? []).filter(isUsefulAttachment).map(toAttachedSkill)
    : usableRules.filter((rule) => hasSkillDocumentPath(rule.path)).map(toAttachedSkill);
  const rules = hasExplicitSkills
    ? usableRules
    : usableRules.filter((rule) => !hasSkillDocumentPath(rule.path));
  return { skills, rules: rules.map(toAttachedRule) };
}
