/** Compatibility export for the Slate-owned retry action factory. */

import { createSlateResumeAgentAction } from "../../../packages/agent/agent-action-state.ts"

export const RESUME_TURN_ACTION = createSlateResumeAgentAction()
