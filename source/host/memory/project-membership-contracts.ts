export type ProjectFolderSlug = string;

export interface ProjectMembershipFileShape {
  readonly projects?: unknown;
}

export interface ProjectMembershipDelta {
  readonly next: ReadonlySet<ProjectFolderSlug>;
  readonly changed: boolean;
}
