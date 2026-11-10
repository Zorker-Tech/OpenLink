import { isAbsolute, join, win32 } from "node:path";
import { normalizeMarketplaceName } from "./manifest-parser.ts";
import type {
  LocalSkillPackagePlan,
  LocalSkillPackageRequest,
  PlannedLocalSkill,
} from "./skill-package-contracts.ts";

function segmentsForPackagePath(value: string): string[] {
  if (isAbsolute(value) || win32.isAbsolute(value)) {
    throw new Error(`Skill path "${value}" must be relative to the skills root`);
  }

  const components = value.split(/[/\\]/).filter((part) => part.length > 0);
  if (components.length === 0 || components.some((part) => part === "." || part === "..")) {
    throw new Error(`Skill path "${value}" resolves to an unsafe path`);
  }
  return components;
}

function planSkillPlacement(source: LocalSkillPackageRequest["skills"][number]): PlannedLocalSkill {
  const pathSegments = segmentsForPackagePath(source.packagePath);
  return {
    sourceDirectory: source.sourceDirectory,
    pathSegments,
    manifestPath: `skills/${pathSegments.join("/")}`,
  };
}

function duplicateManifestPaths(skills: readonly PlannedLocalSkill[]): string[] {
  const seen = new Set<string>();
  const repeated: string[] = [];
  for (const skill of skills) {
    if (seen.has(skill.manifestPath)) repeated.push(skill.manifestPath);
    else seen.add(skill.manifestPath);
  }
  return repeated;
}

export function planLocalSkillPackage(request: LocalSkillPackageRequest): LocalSkillPackagePlan {
  if (request.skills.length === 0) {
    throw new Error("At least one skill directory is required");
  }

  const packageName = normalizeMarketplaceName(request.name);
  if (packageName.length === 0) {
    throw new Error(`Plugin name "${request.name}" has no usable characters`);
  }

  const skills = request.skills.map(planSkillPlacement);
  const duplicates = duplicateManifestPaths(skills);
  if (duplicates.length > 0) {
    throw new Error(`Multiple skill folders would pack to the same path: ${duplicates.join(", ")}`);
  }

  const outputDirectory = join(request.targetDirectory, packageName);
  return {
    outputDirectory,
    skillsDirectory: join(outputDirectory, "skills"),
    packageName,
    displayName: request.displayName ?? request.name,
    skills,
  };
}
