/**
 * The experiment that gives some users a different model selection.
 *
 * A user is put in one of two arms and is told which one they are in, and the environment can put a build in an arm
 * outright — which is what makes the experiment testable before it is rolled out. A user who is in no group is not in
 * the experiment at all, rather than being quietly treated as a control.
 */
import type { SlateAgentModelSelection } from "../../agents/slate-agent-model.ts";

/** The experiment this platform runs on its own model selection. */
export const SLATE_MODEL_EXPERIMENT_NAME = "slate_model_selection";

/** The parameters the treatment arm runs with: thinking on, a long context, medium effort, and fast off. */
const OPUS_MEDIUM_PARAMETERS: SlateAgentModelSelection["parameters"] = [{ id: "thinking", value: "true" }, { id: "context", value: "1m" }, { id: "effort", value: "medium" }, { id: "fast", value: "false" }];

/** The selection the treatment arm runs: the largest model, with those parameters. */
export const SLATE_MODEL_EXPERIMENT_OPUS_MEDIUM_SELECTION: SlateAgentModelSelection = { modelId: "claude-opus-4-8", maxMode: true, parameters: OPUS_MEDIUM_PARAMETERS };

/** Which arm a build is in. */
export type SlateModelExperimentState = { readonly active: true; readonly arm: "control" | "treatment" };

/** What decides a build's arm: an environment override, the group it was put in, and whether that group is enabled. */
interface SlateModelExperimentInputs {
  envOverride?: SlateModelExperimentState;
  groupName: string | null;
  enabled: boolean;
}

/** The words the environment may use, and the arm each puts the build in. */
const ENV_OVERRIDE_ARMS: ReadonlyMap<string, SlateModelExperimentState["arm"]> = new Map([
  ["control", "control"],
  ["treatment", "treatment"],
  ["test", "treatment"],
]);

/** The arm the environment puts this build in, when it says so. */
export function readSlateModelExperimentEnvOverride(env: NodeJS.ProcessEnv = process.env): SlateModelExperimentState | undefined {
  const raw = env.SLATE_MODEL_EXPERIMENT_OVERRIDE?.trim().toLowerCase();
  if (raw === undefined) return undefined;
  const arm = ENV_OVERRIDE_ARMS.get(raw);
  return arm === undefined ? undefined : { active: true, arm };
}

/** The arm this build is in: the environment first, then the group it was put in, and none when it is in no group. */
export function resolveSlateModelExperimentState(inputs: SlateModelExperimentInputs): SlateModelExperimentState | undefined {
  if (inputs.envOverride != null) return inputs.envOverride;
  if (inputs.groupName == null) return undefined;
  return { active: true, arm: inputs.enabled ? "treatment" : "control" };
}
