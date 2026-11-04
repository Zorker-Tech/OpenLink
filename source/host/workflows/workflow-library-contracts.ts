import type { WorkflowSpec } from "../../shared/workflow-model.ts";

export const WORKFLOW_CHANGE_DEBOUNCE_MS = 50;

export interface GlobalWorkflowRecord {
  id: string;
  name: string;
  description: string;
  body: string;
  suggestedTrigger: WorkflowSpec["trigger"];
  sourceRef: string | null;
  helperScripts: string[];
  createdAt: number;
  filePath: string;
}
