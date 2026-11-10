/**
 * Writing a plugin out of skills the workspace already has.
 *
 * A skill that was published is fetched back as a plugin, so the skills a workspace holds are written out as one: each
 * skill's files are copied under a directory named after it, and a path that would leave the plugin — absolute, empty
 * or stepping up — is refused rather than copied, since a plugin's own layout is not a place to escape from.
 */
import { cp, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  LocalSkillPackageManifest,
  LocalSkillPackageRequest,
} from "./skill-package-contracts.ts";
import { planLocalSkillPackage } from "./skill-package-layout.ts";

export async function writeLocalSkillPackage(
  request: LocalSkillPackageRequest,
): Promise<string> {
  const plan = planLocalSkillPackage(request);
  await mkdir(plan.skillsDirectory, { recursive: true });

  for (const skill of plan.skills) {
    const destination = join(plan.skillsDirectory, ...skill.pathSegments);
    await mkdir(dirname(destination), { recursive: true });
    await cp(skill.sourceDirectory, destination, { recursive: true, dereference: true });
  }

  const manifest: LocalSkillPackageManifest = {
    name: plan.packageName,
    displayName: plan.displayName,
    skills: plan.skills.map((skill) => skill.manifestPath),
  };
  await writeFile(
    join(plan.outputDirectory, "plugin.json"),
    JSON.stringify(manifest, null, 2),
    "utf8",
  );
  return plan.outputDirectory;
}
