/**
 * The experiment that gives some users a different model selection.
 *
 * A user is put in one of two arms and is told which one they are in, and the environment can put a build in an arm
 * outright — which is what makes the experiment testable before it is rolled out. A user who is in no group is not in
 * the experiment at all, rather than being quietly treated as a control.
 */
import type { SlateAgentModelSelection } from "../../agents/slate-agent-model.js";
export const SLATE_MODEL_EXPERIMENT_NAME = "slate_model_selection";
export const SLATE_MODEL_EXPERIMENT_OPUS_MEDIUM_SELECTION: SlateAgentModelSelection = { modelId: "claude-opus-4-8", maxMode: true, parameters: [{ id: "thinking", value: "true" }, { id: "context", value: "1m" }, { id: "effort", value: "medium" }, { id: "fast", value: "false" }] };
export type SlateModelExperimentState = { readonly active: true; readonly arm: "control" | "treatment" };
export function readSlateModelExperimentEnvOverride(env: NodeJS.ProcessEnv = process.env): SlateModelExperimentState | undefined { const raw = env.SLATE_MODEL_EXPERIMENT_OVERRIDE?.trim().toLowerCase(); if (raw === "control") return { active: true, arm: "control" }; if (raw === "treatment" || raw === "test") return { active: true, arm: "treatment" }; return undefined; }
export function resolveSlateModelExperimentState(inputs: { envOverride?: SlateModelExperimentState; groupName: string | null; enabled: boolean }): SlateModelExperimentState | undefined { if (inputs.envOverride != null) return inputs.envOverride; return inputs.groupName == null ? undefined : { active: true, arm: inputs.enabled ? "treatment" : "control" }; }
