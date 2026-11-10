export interface SkillAttachmentSource {
  readonly path?: string;
  readonly text?: string;
  readonly pluginName?: unknown;
  readonly marketplaceName?: unknown;
  readonly pluginId?: unknown;
  readonly marketplaceId?: unknown;
}

export interface SkillAttachmentSelection {
  readonly explicitSkills?: readonly SkillAttachmentSource[];
  readonly ruleCandidates?: readonly (SkillAttachmentSource | undefined)[];
}

export interface AttachedSkill {
  readonly path: string;
  readonly text: string;
  readonly pluginName?: unknown;
  readonly marketplaceName?: unknown;
  readonly pluginId?: unknown;
  readonly marketplaceId?: unknown;
}

export interface AttachedRule {
  readonly path?: string;
  readonly text?: string;
  readonly pluginName?: unknown;
  readonly marketplaceName?: unknown;
  readonly pluginId?: unknown;
  readonly marketplaceId?: unknown;
}

export interface ResolvedSkillAttachments {
  readonly skills: AttachedSkill[];
  readonly rules: AttachedRule[];
}
