export const PROJECT_STORAGE_RELATIVE_PATH = ".slate/projects";

export interface ManagedProjectPathMatch {
  readonly workspaceId: string;
  readonly nestedParts: readonly string[];
}
