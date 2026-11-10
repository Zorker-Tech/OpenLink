/** Writes routines and workflows through their source-aware stores. */
import { describeTrigger } from "../../shared/automation-schedule.ts";
import { stateWriteFailed, stateWriteOk, type AgentStateDeps } from "./agent-state-contracts.ts";

function routineResult(value: ReturnType<AgentStateDeps["automations"]["upsert"]>, verb: string) {
  if (value === null) return stateWriteFailed("the routine could not be saved — check that the name and instruction are non-empty and the trigger is valid.");
  return stateWriteOk(`${verb} routine "${value.name}" (folder ${value.id}) — ${describeTrigger(value.trigger)}${value.isEnabled ? "" : ", paused"}.`);
}

export function createAgentWorkflowOperations(deps: AgentStateDeps, now: () => number) {
  return {
    async createAutomation(args: { spec: unknown }) {
      return routineResult(deps.automations.upsert(args.spec, now()), "Saved");
    },
    async updateAutomation(args: { id: string; spec: unknown }) {
      const updated = deps.automations.update(args.id, args.spec);
      if (updated === null) return stateWriteFailed(`no routine with folder "${args.id}" exists, or the new fields were invalid.`);
      return routineResult(updated, "Updated");
    },
    async setAutomationEnabled(args: { id: string; isEnabled: boolean }) {
      const routine = deps.automations.setEnabled(args.id, args.isEnabled);
      if (routine === null) return stateWriteFailed(`no routine with folder "${args.id}" exists.`);
      return stateWriteOk(`${args.isEnabled ? "Resumed" : "Paused"} routine "${routine.name}" (folder ${routine.id}).`);
    },
    async deleteAutomation(args: { id: string }) {
      const name = deps.automations.get(args.id)?.name ?? args.id;
      return deps.automations.remove(args.id)
        ? stateWriteOk(`Deleted routine "${name}" (folder ${args.id}).`)
        : stateWriteFailed(`no routine with folder "${args.id}" exists.`);
    },
    async writeWorkflow(args: { id?: string; name: string; description?: string; body: string }) {
      const spec = { name: args.name, description: args.description ?? "", body: args.body, trigger: null };
      const result = args.id == null ? deps.workflows.create(spec) : deps.workflows.update(args.id, spec);
      if (result === null) {
        return stateWriteFailed(args.id == null
          ? "the workflow could not be saved — a name and a non-empty body are both required."
          : `no workflow with id "${args.id}" exists, or the new fields were invalid. Platform-managed skills cannot be edited.`);
      }
      return stateWriteOk(`${args.id == null ? "Saved" : "Updated"} workflow "${result.name}" (id ${result.id}).`);
    },
    async deleteWorkflow(args: { id: string }) {
      return deps.workflows.remove(args.id)
        ? stateWriteOk(`Deleted workflow ${args.id}.`)
        : stateWriteFailed(`no workflow with id "${args.id}" exists, or it is a platform-managed skill, which cannot be deleted.`);
    },
  };
}
