import { AgentWorkflowAccess } from "../agents/agent-workflow-enablement.ts";
import { clampWorkflowName, deriveWorkflowNameFromUrl, liveWorkflowSpecFromSource, workflowSpecFromMarkdown } from "../../shared/workflow-model.ts";
import { GlobalWorkflowLibrary } from "./workflow-library.ts";
import { discoverLocalSkillFiles } from "./workflow-store-sources.ts";
import type { WorkflowImportResult } from "./workflow-store-contracts.ts";

export class WorkflowImportService {
  constructor(
    private readonly library: GlobalWorkflowLibrary,
    private readonly enablement: AgentWorkflowAccess,
  ) {}

  fromMarkdown(markdown: string, fallbackName?: string): WorkflowImportResult | null {
    const spec = workflowSpecFromMarkdown(markdown, fallbackName);
    if (spec == null) return null;
    const record = this.library.create({ ...spec, trigger: null });
    if (record == null) return null;
    this.enablement.setWorkflowEnabled(record.id, true);
    return { id: record.id, name: record.name };
  }

  fromLiveSource(source: string, fallbackName?: string): WorkflowImportResult | null {
    const normalizedSource = source.trim();
    const name = clampWorkflowName(fallbackName ?? deriveWorkflowNameFromUrl(normalizedSource));
    if (normalizedSource.length === 0 || name.length === 0) return null;

    const record = this.library.create(liveWorkflowSpecFromSource({ name, source: normalizedSource }));
    if (record == null) return null;
    this.enablement.setWorkflowEnabled(record.id, true);
    return { id: record.id, name: record.name };
  }

  portLocalSkills(homeDir: string, cwd: string): {
    readonly imported: WorkflowImportResult[];
    readonly skipped: Array<{ readonly source: string; readonly reason: string }>;
  } {
    const imported: WorkflowImportResult[] = [];
    const skipped: Array<{ source: string; reason: string }> = [];
    for (const source of discoverLocalSkillFiles(homeDir, cwd)) {
      const result = this.fromLiveSource(source.path, source.fallbackName);
      if (result == null) skipped.push({ source: source.label, reason: "could not link" });
      else imported.push(result);
    }
    return { imported, skipped };
  }
}
