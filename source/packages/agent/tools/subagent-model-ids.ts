import { SLATE_SUBAGENT_MODEL_IDS } from "../../../adapters/interop/agent/subagent-model-id-adapter.ts"

export const SubagentModelId = SLATE_SUBAGENT_MODEL_IDS

export type SubagentModelId = (typeof SubagentModelId)[keyof typeof SubagentModelId]
