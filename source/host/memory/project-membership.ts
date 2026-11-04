/**
 * Which projects an agent is a member of.
 *
 * The membership is one file beside the agent holding safe folder slugs, and writing it is atomic, so a file that is
 * half written is never read; a slug that is not one is dropped rather than trusted.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProjectFolderSlug } from "./project-membership-contracts.ts";
import {
  addProjectMembership,
  encodeProjectMembership,
  isProjectFolderSlug,
  projectMembershipFromDocument,
  retainExistingProjects,
  removeProjectMembership,
} from "./project-membership-policy.ts";

export const AGENT_PROJECTS_FILE = "projects.json";
export function agentProjectMembershipPath(agentDir: string): string {
  return join(agentDir, AGENT_PROJECTS_FILE);
}

export class AgentProjectMembershipStore {
  constructor(readonly agentDir: string) {}

  get path(): string {
    return agentProjectMembershipPath(this.agentDir);
  }

  read(): Set<ProjectFolderSlug> {
    try {
      const document: unknown = JSON.parse(readFileSync(this.path, "utf8"));
      return projectMembershipFromDocument(document);
    } catch {
      return new Set();
    }
  }

  write(slugs: ReadonlySet<ProjectFolderSlug>): void {
    mkdirSync(this.agentDir, { recursive: true });
    const stagingPath = `${this.path}.tmp`;
    writeFileSync(stagingPath, encodeProjectMembership(slugs), "utf8");
    renameSync(stagingPath, this.path);
  }

  join(slug: string): boolean {
    if (!isProjectFolderSlug(slug)) return false;
    const delta = addProjectMembership(this.read(), slug);
    if (delta.changed) this.write(delta.next);
    return true;
  }

  leave(slug: string): boolean {
    if (!isProjectFolderSlug(slug)) return false;
    const delta = removeProjectMembership(this.read(), slug);
    if (delta.changed) this.write(delta.next);
    return true;
  }

  pruneMissing(projectExists: (slug: string) => boolean): void {
    const delta = retainExistingProjects(this.read(), projectExists);
    if (delta.changed) this.write(delta.next);
  }
}
