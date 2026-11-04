export const LEGACY_WORKFLOWS_DIRNAME = "workflows";
export const MANAGED_SKILLS_CHANGE_DEBOUNCE_MS = 50;

export interface LocalSkillFile {
  readonly path: string;
  readonly label: string;
  readonly fallbackName: string;
}

export interface WorkflowImportResult {
  readonly id: string;
  readonly name: string;
}
