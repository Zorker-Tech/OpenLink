export interface LocalSkillPackageSource {
  readonly sourceDirectory: string;
  readonly packagePath: string;
}

export interface LocalSkillPackageRequest {
  readonly skills: readonly LocalSkillPackageSource[];
  readonly targetDirectory: string;
  readonly name: string;
  readonly displayName?: string;
}

export interface PlannedLocalSkill {
  readonly sourceDirectory: string;
  readonly pathSegments: readonly string[];
  readonly manifestPath: string;
}

export interface LocalSkillPackagePlan {
  readonly outputDirectory: string;
  readonly skillsDirectory: string;
  readonly packageName: string;
  readonly displayName: string;
  readonly skills: readonly PlannedLocalSkill[];
}

export interface LocalSkillPackageManifest {
  readonly name: string;
  readonly displayName: string;
  readonly skills: readonly string[];
}
