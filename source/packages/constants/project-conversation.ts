/**
 * What kind of project conversation this is.
 *
 * A conversation can be a project's root conversation, a subagent's, or a side chat's. Only the root
 * one is the project itself — the others are work done on its behalf — so the check for "is this the
 * root" has to look at both markers rather than at one of them.
 */

export interface ProjectDetails {
  readonly subagent?: unknown
  readonly sideChat?: unknown
}

export function isRootProjectDetails(projectDetails: ProjectDetails | null | undefined): boolean {
  return projectDetails != null && projectDetails.subagent === undefined && projectDetails.sideChat === undefined
}
