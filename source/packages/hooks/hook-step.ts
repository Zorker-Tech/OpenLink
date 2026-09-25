/**
 * The points in a turn where a hook may run.
 *
 * The names are the wire names: a hook configuration file on disk spells its events exactly like
 * this, so the strings are a contract and not a label. The set is closed — a step that is not here
 * cannot be configured — which is what makes the validator's "unknown hook type" check possible.
 */

export const HookStep = {
  beforeShellExecution: "beforeShellExecution",
  beforeMCPExecution: "beforeMCPExecution",
  afterShellExecution: "afterShellExecution",
  afterMCPExecution: "afterMCPExecution",
  beforeReadFile: "beforeReadFile",
  afterFileEdit: "afterFileEdit",
  beforeTabFileRead: "beforeTabFileRead",
  afterTabFileEdit: "afterTabFileEdit",
  stop: "stop",
  beforeSubmitPrompt: "beforeSubmitPrompt",
  afterAgentResponse: "afterAgentResponse",
  afterAgentThought: "afterAgentThought",
  sessionStart: "sessionStart",
  sessionEnd: "sessionEnd",
  preCompact: "preCompact",
  subagentStart: "subagentStart",
  subagentStop: "subagentStop",
  preToolUse: "preToolUse",
  postToolUse: "postToolUse",
  postToolUseFailure: "postToolUseFailure",
  workspaceOpen: "workspaceOpen",
} as const

export type HookStep = (typeof HookStep)[keyof typeof HookStep]

/** Every configured step, in declaration order: what the config validator reports as valid. */
export const HOOK_STEPS: readonly HookStep[] = Object.values(HookStep)
