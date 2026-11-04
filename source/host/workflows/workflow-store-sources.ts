import { dirname, join } from "node:path";
import { readFileSync, readdirSync, statSync, type Dirent } from "node:fs";
import { parseWorkflowFile, type WorkflowRecord } from "../../shared/workflow-model.ts";
import { AgentWorkflowAccess } from "../agents/agent-workflow-enablement.ts";
import {
  getManagedSkillFilePath,
  getManagedSkillsCachePath,
  readManagedSkillsCache,
  type ManagedSkill,
} from "../extensions/managed-setup/managed-skills-cache.ts";
import {
  getPluginSkillsCachePath,
  readPluginSkillsCache,
  type PluginSkillRecord,
  type PluginSkillsCache,
} from "../skills/plugin-skills-cache.ts";
import { StatKeyedParseCache } from "./stat-keyed-parse-cache.ts";
import { GlobalWorkflowLibrary, type GlobalWorkflowRecord } from "./workflow-library.ts";
import { LEGACY_WORKFLOW_FILENAME } from "../../shared/workflow-model.ts";
import { LEGACY_WORKFLOWS_DIRNAME, type LocalSkillFile } from "./workflow-store-contracts.ts";

interface PluginSkillFacts {
  readonly name: string;
  readonly description: string;
  readonly body: string;
  readonly disableModelInvocation: boolean;
  readonly helperScripts: string[];
}

const pluginSkillFiles = new StatKeyedParseCache();
const managedSkillIndexes = new StatKeyedParseCache();
const pluginSkillIndexes = new StatKeyedParseCache();

export function readPluginSkillFileFacts(path: string): PluginSkillFacts | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }

  const parsed = parseWorkflowFile(raw);
  if (parsed == null || parsed.body.length === 0) return null;
  let helperScripts: string[] = [];
  try {
    helperScripts = readdirSync(dirname(path), { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name !== "SKILL.md")
      .map((entry) => entry.name)
      .sort();
  } catch {
    // Missing sibling files do not invalidate an otherwise readable skill.
  }

  return {
    name: parsed.name,
    description: parsed.description,
    body: parsed.body,
    disableModelInvocation: parsed.data["disable-model-invocation"] === true,
    helperScripts,
  };
}

export function agentHasWorkflows(agentDir: string): boolean {
  if (new AgentWorkflowAccess(agentDir).hasWorkflowFlags()) return true;
  const legacyDir = join(agentDir, LEGACY_WORKFLOWS_DIRNAME);
  let entries: Dirent[];
  try {
    entries = readdirSync(legacyDir, { withFileTypes: true });
  } catch {
    return false;
  }

  return entries.some((entry) => {
    if (!entry.isDirectory()) return false;
    try {
      statSync(join(legacyDir, entry.name, LEGACY_WORKFLOW_FILENAME));
      return true;
    } catch {
      return false;
    }
  });
}

export class WorkflowSourceCatalog {
  constructor(
    readonly managedDir: string,
    readonly pluginSkillsDir: string,
    private readonly enablement: AgentWorkflowAccess,
  ) {}

  managedWorkflows(excludedIds = new Set<string>()): WorkflowRecord[] {
    const index = this.readManagedSkillsIndex();
    if (index == null) return [];
    return index.skills
      .filter((skill) => !excludedIds.has(skill.id))
      .map((skill) => this.managedSkillToWorkflow(skill, index.fetchedAt));
  }

  pluginWorkflows(excludedIds = new Set<string>()): WorkflowRecord[] {
    const index = this.readPluginSkillsIndex();
    if (index == null) return [];
    return index.skills.flatMap((skill) => {
      if (excludedIds.has(skill.id)) return [];
      const projection = this.pluginSkillToWorkflow(skill, index);
      return projection == null ? [] : [projection];
    });
  }

  pluginSkillRecord(id: string): PluginSkillRecord | null {
    return this.readPluginSkillsIndex()?.skills.find((skill) => skill.id === id) ?? null;
  }

  readManagedSkillsIndex() {
    return managedSkillIndexes.read(
      [getManagedSkillsCachePath(this.managedDir)],
      () => readManagedSkillsCache(this.managedDir),
    );
  }

  readPluginSkillsIndex() {
    return pluginSkillIndexes.read(
      [getPluginSkillsCachePath(this.pluginSkillsDir)],
      () => readPluginSkillsCache(this.pluginSkillsDir),
    );
  }

  managedSkillToWorkflow(skill: ManagedSkill, fetchedAt: number): WorkflowRecord {
    const path = getManagedSkillFilePath(this.managedDir, skill.id);
    let fileExists = false;
    try {
      fileExists = statSync(path).isFile();
    } catch {
      // The cache remains a source of truth if materialization has not happened yet.
    }
    return {
      id: skill.id,
      name: skill.name,
      description: skill.description,
      body: skill.body,
      trigger: null,
      source: "managed",
      sourceRef: null,
      pluginId: null,
      publishedByCurrentUser: false,
      isEnabledForAgent: true,
      scheduleDescription: null,
      createdAt: fetchedAt,
      lastRunAt: null,
      nextRunAt: null,
      helperScripts: [],
      runs: [],
      filePath: fileExists ? path : getManagedSkillsCachePath(this.managedDir),
    };
  }

  pluginSkillToWorkflow(skill: PluginSkillRecord, index: PluginSkillsCache): WorkflowRecord | null {
    const facts = pluginSkillFiles.read(
      [skill.filePath, dirname(skill.filePath)],
      () => readPluginSkillFileFacts(skill.filePath),
    );
    if (facts == null) return null;
    return {
      id: skill.id,
      name: facts.name || skill.name,
      description: facts.description || skill.description,
      body: facts.body,
      trigger: null,
      source: "plugin",
      sourceRef: null,
      pluginId: skill.pluginId,
      publishedByCurrentUser: skill.publisherUserId != null && skill.publisherUserId === index.currentUserId,
      isEnabledForAgent: true,
      disableModelInvocation: facts.disableModelInvocation,
      scheduleDescription: null,
      createdAt: index.fetchedAt,
      lastRunAt: null,
      nextRunAt: null,
      helperScripts: facts.helperScripts,
      runs: [],
      filePath: skill.filePath,
    };
  }
}

export function discoverLocalSkillFiles(homeDir: string, cwd: string): LocalSkillFile[] {
  const found: LocalSkillFile[] = [];
  const seen = new Set<string>();
  const addIfPresent = (path: string, label: string, fallbackName: string) => {
    if (seen.has(path)) return;
    seen.add(path);
    try {
      if (statSync(path).isFile()) found.push({ path, label, fallbackName });
    } catch {
      // Missing optional sources are not errors.
    }
  };

  for (const directory of [cwd, homeDir]) {
    addIfPresent(join(directory, "CLAUDE.md"), `${directory}/CLAUDE.md`, "Claude memory");
    addIfPresent(join(directory, "AGENTS.md"), `${directory}/AGENTS.md`, "Agents memory");
    addIfPresent(join(directory, ".claude", "CLAUDE.md"), `${directory}/.claude/CLAUDE.md`, "Claude memory");
  }

  let rules: Dirent[] = [];
  try {
    rules = readdirSync(join(cwd, ".cursor", "rules"), { withFileTypes: true });
  } catch {
    // Project rules are optional.
  }
  for (const entry of rules) {
    if (!entry.isFile() || !/\.(mdc|md)$/i.test(entry.name)) continue;
    const file = join(cwd, ".cursor", "rules", entry.name);
    const fallbackName = entry.name.replace(/\.(mdc|md)$/i, "");
    addIfPresent(file, `.cursor/rules/${entry.name}`, fallbackName);
  }
  return found;
}

export function workflowFromLibraryRecord(
  record: GlobalWorkflowRecord,
  enablement: AgentWorkflowAccess,
): WorkflowRecord {
  return {
    id: record.id,
    name: record.name,
    description: record.description,
    body: record.body,
    trigger: null,
    source: "workflow",
    sourceRef: record.sourceRef,
    pluginId: null,
    publishedByCurrentUser: false,
    isEnabledForAgent: enablement.isWorkflowEnabled(record.id),
    scheduleDescription: null,
    createdAt: record.createdAt,
    lastRunAt: null,
    nextRunAt: null,
    helperScripts: record.helperScripts,
    runs: [],
    filePath: record.filePath,
  };
}
