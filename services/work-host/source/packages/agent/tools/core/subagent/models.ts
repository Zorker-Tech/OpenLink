/** The subagent model choices that are safe to show and use. */

import { SubagentModelId } from "../../subagent-model-ids.ts";

interface ModelDefinition {
  readonly slug: string;
}

export interface SubagentModels {
  readonly modelsBySlug: ReadonlyMap<string, ModelDefinition>;
}

export const DEFAULT_SUBAGENT_SLUG = SubagentModelId.standard;

export function createSubagentModels(
  models: Readonly<Record<string, ModelDefinition>>,
  isModelBlocked?: (slug: string) => boolean,
): SubagentModels {
  const visible = Object.values(models).filter(({ slug }) => !isModelBlocked?.(slug));
  return {
    modelsBySlug: new Map(visible.map((model) => [model.slug, model] as const)),
  };
}

const EMPTY_MODELS_DESCRIPTION = "No alternative child model is available. Children use the parent model.";

function modelChoiceLines(models: SubagentModels, includeInheritOption: boolean): string[] {
  const choices = [...models.modelsBySlug.keys()].sort().map((slug) => `- ${slug}`);
  if (!includeInheritOption) return choices;
  return ["- inherit — default; keep the parent model unless the user requests a different one", ...choices];
}

export function buildAvailableModelsDescription(
  subagentModels: SubagentModels,
  includeInheritOption = false,
): string {
  if (subagentModels.modelsBySlug.size === 0) return EMPTY_MODELS_DESCRIPTION;

  return [
    [
      "If the user names a model for a child task, choose only model identifiers from this list:",
      ...modelChoiceLines(subagentModels, includeInheritOption),
    ].join("\n"),
    "If the user names a model family without a version, choose its newest listed version.",
    "If the requested identifier is missing, do not substitute another model or guess. Skip the launch and tell the user what was unavailable and which choices are listed.",
    "When describing your selection, use the same naming style the user used. Show the raw kebab-case identifier only when the user used that form.",
  ].join("\n\n");
}
