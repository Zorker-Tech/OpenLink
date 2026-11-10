/** Per-agent workflow switches stored as a stable set of disabled ids. */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const AGENT_WORKFLOW_STATE_FILENAME = "enabled-workflows.json";

export function agentWorkflowStatePath(agentDirectory: string): string {
  return join(agentDirectory, AGENT_WORKFLOW_STATE_FILENAME);
}

type WorkflowState = Record<string, unknown>;

function isWorkflowState(value: unknown): value is WorkflowState {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringIds(value: unknown): Set<string> {
  if (!Array.isArray(value)) return new Set();
  return new Set(value.filter((candidate): candidate is string => typeof candidate === "string"));
}

function idsInState(state: WorkflowState, field: "disabled" | "enabled"): Set<string> {
  return stringIds(state[field]);
}

function readWorkflowState(filePath: string): WorkflowState {
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
    return isWorkflowState(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeWorkflowState(
  agentDirectory: string,
  filePath: string,
  disabledIds: ReadonlySet<string>,
  legacyEnabledIds: ReadonlySet<string>
): void {
  mkdirSync(agentDirectory, { recursive: true });
  const nextState = {
    disabled: [...disabledIds].sort(),
    ...(legacyEnabledIds.size === 0 ? {} : { enabled: [...legacyEnabledIds].sort() }),
  };
  const temporaryPath = `${filePath}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(nextState, null, 2)}\n`, "utf8");
  renameSync(temporaryPath, filePath);
}

export class AgentWorkflowAccess {
  constructor(readonly agentDirectory: string) {}

  get filePath(): string {
    return agentWorkflowStatePath(this.agentDirectory);
  }

  #state(): WorkflowState {
    return readWorkflowState(this.filePath);
  }

  #disabledIds(): Set<string> {
    return idsInState(this.#state(), "disabled");
  }

  #persistDisabledIds(disabledIds: ReadonlySet<string>): void {
    const legacyEnabledIds = idsInState(this.#state(), "enabled");
    writeWorkflowState(this.agentDirectory, this.filePath, disabledIds, legacyEnabledIds);
  }

  isWorkflowEnabled(id: string): boolean {
    return !this.#disabledIds().has(id);
  }

  hasWorkflowFlags(): boolean {
    const state = this.#state();
    return idsInState(state, "disabled").size > 0 || idsInState(state, "enabled").size > 0;
  }

  setWorkflowEnabled(id: string, enabled: boolean): void {
    const disabledIds = this.#disabledIds();
    const alreadyDisabled = disabledIds.has(id);
    if (alreadyDisabled === !enabled) return;
    if (enabled) disabledIds.delete(id);
    else disabledIds.add(id);
    this.#persistDisabledIds(disabledIds);
  }

  forgetWorkflow(id: string): void {
    const disabledIds = this.#disabledIds();
    if (disabledIds.delete(id)) this.#persistDisabledIds(disabledIds);
  }

  enableWorkflows(ids: readonly string[]): void {
    const disabledIds = this.#disabledIds();
    let changed = false;
    for (const id of ids) if (disabledIds.delete(id)) changed = true;
    if (changed) this.#persistDisabledIds(disabledIds);
  }
}
