/** Project counterpart model metadata into Slate's persistence-guidance capability. */

import type { PersistenceModelInfo } from "../../../packages/agent/prompts/persistence-instructions.ts";

export interface InteropPersistenceModelInfo {
  readonly isGpt5?: boolean | undefined;
  readonly isGpt5Family?: boolean | undefined;
  readonly isGpt51?: boolean | undefined;
  readonly isGpt52?: boolean | undefined;
  readonly isGpt54?: boolean | undefined;
  readonly isGpt55?: boolean | undefined;
  readonly isGpt56?: boolean | undefined;
  readonly isGpt52Codex?: boolean | undefined;
  readonly isGpt53Codex?: boolean | undefined;
  readonly isGpt53CodexSpark?: boolean | undefined;
}

const LONG_RUNNING_GUIDANCE_MODEL_FLAGS = [
  "isGpt5",
  "isGpt5Family",
  "isGpt51",
  "isGpt52",
  "isGpt54",
  "isGpt55",
  "isGpt56",
  "isGpt52Codex",
  "isGpt53Codex",
  "isGpt53CodexSpark",
] as const;

export function adaptPersistenceModelInfo(value: unknown): PersistenceModelInfo | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const fields = value as Record<string, unknown>;
  return {
    needsLongRunningWorkGuidance: LONG_RUNNING_GUIDANCE_MODEL_FLAGS.some((flag) => fields[flag] === true),
  };
}
