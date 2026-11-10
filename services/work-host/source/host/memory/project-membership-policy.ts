import { isSafeFolderId } from "../storage/folder-id.ts";
import type {
  ProjectFolderSlug,
  ProjectMembershipDelta,
  ProjectMembershipFileShape,
} from "./project-membership-contracts.ts";

export function isProjectFolderSlug(value: unknown): value is ProjectFolderSlug {
  return typeof value === "string" && isSafeFolderId(value);
}

export function decodeProjectMembership(value: unknown): Set<ProjectFolderSlug> {
  if (!Array.isArray(value)) return new Set();
  return new Set(value.filter(isProjectFolderSlug));
}

export function projectMembershipFromDocument(value: unknown): Set<ProjectFolderSlug> {
  if (value === null || typeof value !== "object") return new Set();
  return decodeProjectMembership((value as ProjectMembershipFileShape).projects);
}

export function encodeProjectMembership(slugs: ReadonlySet<ProjectFolderSlug>): string {
  return `${JSON.stringify({ projects: [...slugs].sort() }, null, 2)}\n`;
}

export function addProjectMembership(
  current: ReadonlySet<ProjectFolderSlug>,
  slug: ProjectFolderSlug,
): ProjectMembershipDelta {
  if (current.has(slug)) return { next: current, changed: false };
  return { next: new Set([...current, slug]), changed: true };
}

export function removeProjectMembership(
  current: ReadonlySet<ProjectFolderSlug>,
  slug: ProjectFolderSlug,
): ProjectMembershipDelta {
  if (!current.has(slug)) return { next: current, changed: false };
  const next = new Set(current);
  next.delete(slug);
  return { next, changed: true };
}

export function retainExistingProjects(
  current: ReadonlySet<ProjectFolderSlug>,
  exists: (slug: ProjectFolderSlug) => boolean,
): ProjectMembershipDelta {
  const next = new Set([...current].filter(exists));
  return { next, changed: next.size !== current.size };
}
