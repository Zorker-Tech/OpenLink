export interface RepositoryAccessGuidance {
  readonly boundary: string
  readonly nextStep: string
}

/** State the session's access boundary and where repository work can continue. */
export function repositoryAccessGuidance(): RepositoryAccessGuidance {
  return {
    boundary: "This run has no repository checkout or source-control credentials. Do not try to clone, push, or open a pull request; this session cannot perform those actions. Treat the missing checkout as an intentional session boundary, not a setup failure.",
    nextStep: "When the request needs repository files, explain this limit and ask the user to resume in a workspace where that repository is checked out.",
  }
}
