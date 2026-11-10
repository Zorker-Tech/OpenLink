/**
 * Where an agent's workflows are kept.
 *
 * One file per workflow beside the agent, written atomically and read defensively, and what is listed is what parses —
 * a file that does not is reported rather than offered as a workflow.
 */
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { createDebouncePolicy, realClock } from "../extensions/scheduling.ts";
import { cronTrigger } from "../../shared/automations.ts";
import { automationToWorkflow, clampWorkflowBody, clampWorkflowName, parseWorkflowFile, serializeWorkflowFile, type WorkflowRecord, type WorkflowSpec } from "../../shared/workflow-model.ts";
import { AgentWorkflowAccess } from "../agents/agent-workflow-enablement.ts";
import { FileAutomationStore, getAgentAutomationsDir } from "../automations/automation-store.ts";
import { getManagedSkillsDir, type ManagedSkill } from "../extensions/managed-setup/managed-skills-cache.ts";
import { getPluginSkillsDir, type PluginSkillRecord, type PluginSkillsCache } from "../skills/plugin-skills-cache.ts";
import { WatchedDirectory } from "../watched-directory.ts";
import { GlobalWorkflowLibrary, type GlobalWorkflowRecord } from "./workflow-library.ts";
import { migrateLegacyPerAgentWorkflows as runLegacyMigration } from "./workflow-store-migration.ts";
import { WorkflowImportService } from "./workflow-store-imports.ts";
import { MANAGED_SKILLS_CHANGE_DEBOUNCE_MS, type LocalSkillFile, type WorkflowImportResult } from "./workflow-store-contracts.ts";
import { WorkflowSourceCatalog, workflowFromLibraryRecord } from "./workflow-store-sources.ts";

export { LEGACY_WORKFLOWS_DIRNAME, MANAGED_SKILLS_CHANGE_DEBOUNCE_MS } from "./workflow-store-contracts.ts";
export type { LocalSkillFile, WorkflowImportResult } from "./workflow-store-contracts.ts";
export { agentHasWorkflows, discoverLocalSkillFiles, readPluginSkillFileFacts } from "./workflow-store-sources.ts";

export class FileWorkflowStore {
  readonly library: GlobalWorkflowLibrary;
  readonly enablement: AgentWorkflowAccess;
  readonly automations: FileAutomationStore;
  readonly managedDir: string;
  readonly managedDirWatcher: WatchedDirectory;
  readonly pluginSkillsDir: string;
  readonly pluginSkillsDirWatcher: WatchedDirectory;
  private readonly sourceCatalog: WorkflowSourceCatalog;
  private readonly importer: WorkflowImportService;

  constructor(readonly agentDir: string, globalDir: string, resolveUserTimeZone: () => string | undefined = () => undefined) {
    const slateRoot = dirname(globalDir);
    const debounce = (name: string) => createDebouncePolicy(realClock, {
      name,
      delayMs: MANAGED_SKILLS_CHANGE_DEBOUNCE_MS,
    });
    this.library = new GlobalWorkflowLibrary(globalDir);
    this.managedDir = getManagedSkillsDir(slateRoot);
    this.managedDirWatcher = new WatchedDirectory(this.managedDir, debounce("slate-managed-skills-change"));
    this.pluginSkillsDir = getPluginSkillsDir(slateRoot);
    this.pluginSkillsDirWatcher = new WatchedDirectory(this.pluginSkillsDir, debounce("slate-plugin-skills-change"));
    this.enablement = new AgentWorkflowAccess(agentDir);
    this.sourceCatalog = new WorkflowSourceCatalog(this.managedDir, this.pluginSkillsDir, this.enablement);
    this.importer = new WorkflowImportService(this.library, this.enablement);
    this.automations = new FileAutomationStore(getAgentAutomationsDir(agentDir), resolveUserTimeZone);
    this.migrateLegacyPerAgentWorkflows();
  }
  getLocation(): string {
    return this.library.getLocation();
  }

  setOnChange(onChange?: (() => void) | null): void {
    this.library.setOnChange(onChange);
    this.managedDirWatcher.setOnChange(onChange);
    this.pluginSkillsDirWatcher.setOnChange(onChange);
    this.automations.setOnChange(onChange);
  }
  skillToWorkflow(record: GlobalWorkflowRecord): WorkflowRecord {
    return workflowFromLibraryRecord(record, this.enablement);
  }

  managedSkillToWorkflow(skill: ManagedSkill, fetchedAt: number): WorkflowRecord {
    return this.sourceCatalog.managedSkillToWorkflow(skill, fetchedAt);
  }

  readManagedSkillsIndex() {
    return this.sourceCatalog.readManagedSkillsIndex();
  }

  readPluginSkillsIndex(): PluginSkillsCache | null {
    return this.sourceCatalog.readPluginSkillsIndex();
  }

  managedWorkflows(excludedIds = new Set<string>()): WorkflowRecord[] {
    return this.sourceCatalog.managedWorkflows(excludedIds);
  }

  pluginSkillToWorkflow(record: PluginSkillRecord, index: PluginSkillsCache): WorkflowRecord | null {
    return this.sourceCatalog.pluginSkillToWorkflow(record, index);
  }

  pluginWorkflows(excludedIds = new Set<string>()): WorkflowRecord[] {
    return this.sourceCatalog.pluginWorkflows(excludedIds);
  }

  pluginSkillRecord(id: string): PluginSkillRecord | null {
    return this.sourceCatalog.pluginSkillRecord(id);
  }
  listAll(): WorkflowRecord[] {
    return this.listAllFrom(false);
  }
  listAllFrom(definitionsOnly: boolean): WorkflowRecord[] {
    const libraryRecords = this.library.list();
    const libraryIds = new Set(libraryRecords.map((record) => record.id));
    const libraryWorkflows = libraryRecords.map((record) => this.skillToWorkflow(record));
    const managed = this.managedWorkflows(libraryIds);
    const alreadyClaimed = new Set([...libraryIds, ...managed.map((workflow) => workflow.id)]);
    const plugins = this.pluginWorkflows(alreadyClaimed);
    const automations = (definitionsOnly ? this.automations.listDefinitions() : this.automations.list())
      .map(automationToWorkflow);
    return [...managed, ...plugins, ...libraryWorkflows, ...automations];
  }
  list(): WorkflowRecord[] {
    return this.listAllFrom(true)
      .filter((workflow) => workflow.isEnabledForAgent || workflow.source === "automation");
  }

  get(id: string): WorkflowRecord | null {
    const libraryRecord = this.library.get(id);
    if (libraryRecord != null) return this.skillToWorkflow(libraryRecord);
    const managed = this.managedWorkflows().find((workflow) => workflow.id === id);
    if (managed != null) return managed;
    const plugin = this.pluginWorkflows().find((workflow) => workflow.id === id);
    if (plugin != null) return plugin;
    const automation = this.automations.get(id);
    return automation == null ? null : automationToWorkflow(automation);
  }

  create(spec: WorkflowSpec): WorkflowRecord | null {
    const name = clampWorkflowName(spec.name);
    if (!name) return null;
    if (spec.trigger != null) return this.createAutomation({ ...spec, name });
    const body = clampWorkflowBody(spec.body);
    if (!body) return null;

    const record = this.library.create({
      name,
      description: spec.description,
      body,
      trigger: null,
      sourceRef: spec.sourceRef ?? null,
    });
    if (record == null) return null;
    this.enablement.setWorkflowEnabled(record.id, true);
    return this.skillToWorkflow(record);
  }

  createAutomation(spec: WorkflowSpec): WorkflowRecord | null {
    if (spec.trigger == null) return null;
    const automation = this.automations.upsert({
      name: spec.name,
      prompt: spec.body,
      trigger: cronTrigger(spec.trigger.schedule),
      isEnabled: spec.trigger.isEnabled,
    });
    return automation == null ? null : automationToWorkflow(automation);
  }

  update(id: string, spec: WorkflowSpec): WorkflowRecord | null {
    const current = this.get(id);
    const name = clampWorkflowName(spec.name);
    if (current == null || !name) return null;

    if (current.source === "automation") {
      return this.updateAutomation(id, name, spec, current);
    }

    const body = clampWorkflowBody(spec.body);
    if (!body) return null;
    if (current.source === "plugin") {
      return current.publishedByCurrentUser
        ? this.updatePluginSkill(id, { name, description: spec.description, body, trigger: null })
        : null;
    }

    const record = this.library.update(id, {
      name,
      description: spec.description,
      body,
      trigger: null,
      sourceRef: spec.sourceRef ?? current.sourceRef,
    });
    return record == null ? null : this.skillToWorkflow(record);
  }

  updatePluginSkill(id: string, spec: WorkflowSpec): WorkflowRecord | null {
    const record = this.pluginSkillRecord(id);
    if (record == null) return null;

    let existing: Record<string, unknown>;
    try {
      existing = parseWorkflowFile(readFileSync(record.filePath, "utf8"))?.data ?? {};
    } catch {
      return null;
    }
    this.pluginSkillsDirWatcher.writeFileAtomic(record.filePath, serializeWorkflowFile({ ...spec, trigger: null }, existing));
    return this.get(id);
  }

  setEnabledForAgent(id: string, enabled: boolean): WorkflowRecord | null {
    const workflow = this.get(id);
    if (workflow?.source === "managed" || workflow?.source === "plugin") return workflow;
    if (this.library.get(id) == null) return null;
    this.enablement.setWorkflowEnabled(id, enabled);
    return this.get(id);
  }

  setTriggerEnabled(id: string, enabled: boolean): WorkflowRecord | null {
    const automation = this.automations.setEnabled(id, enabled);
    return automation == null ? null : automationToWorkflow(automation);
  }

  remove(id: string): boolean {
    const source = this.get(id)?.source;
    if (source === "managed" || source === "plugin") return false;
    if (this.library.get(id) != null) {
      this.enablement.forgetWorkflow(id);
      return this.library.remove(id);
    }
    return this.automations.remove(id);
  }

  importMarkdown(markdown: string, fallbackName?: string): WorkflowImportResult | null {
    return this.importer.fromMarkdown(markdown, fallbackName);
  }

  importLiveSource(source: string, fallbackName?: string): WorkflowImportResult | null {
    return this.importer.fromLiveSource(source, fallbackName);
  }

  portLocalSkills(homeDir: string, cwd: string): { imported: WorkflowImportResult[]; skipped: Array<{ source: string; reason: string }> } {
    return this.importer.portLocalSkills(homeDir, cwd);
  }

  migrateLegacyPerAgentWorkflows(): void {
    runLegacyMigration(this.agentDir, this.library, this.enablement);
  }

  private updateAutomation(id: string, name: string, spec: WorkflowSpec, current: WorkflowRecord): WorkflowRecord | null {
    const enabled = spec.trigger?.isEnabled ?? current.trigger?.isEnabled ?? true;
    const schedule = spec.trigger?.schedule ?? current.trigger?.schedule ?? "";
    const existing = this.automations.get(id);
    const trigger = schedule.trim() ? cronTrigger(schedule) : existing?.trigger ?? cronTrigger("");
    const automation = this.automations.update(id, {
      name,
      prompt: spec.body,
      trigger,
      isEnabled: enabled,
    });
    return automation == null ? null : automationToWorkflow(automation);
  }
}
