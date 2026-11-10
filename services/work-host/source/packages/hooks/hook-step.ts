const STEP_NAMES = [
  "beforeShellExecution",
  "beforeMCPExecution",
  "afterShellExecution",
  "afterMCPExecution",
  "beforeReadFile",
  "afterFileEdit",
  "beforeTabFileRead",
  "afterTabFileEdit",
  "stop",
  "beforeSubmitPrompt",
  "afterAgentResponse",
  "afterAgentThought",
  "sessionStart",
  "sessionEnd",
  "preCompact",
  "subagentStart",
  "subagentStop",
  "preToolUse",
  "postToolUse",
  "postToolUseFailure",
  "workspaceOpen",
] as const;

export type HookStep = (typeof STEP_NAMES)[number];

type HookStepCatalog = { readonly [Step in HookStep]: Step };

function makeHookStepCatalog(names: readonly HookStep[]): HookStepCatalog {
  return Object.fromEntries(names.map(name => [name, name])) as HookStepCatalog;
}

export const HookStep = makeHookStepCatalog(STEP_NAMES);

/** All valid configured step names in their catalog order. */
export const HOOK_STEPS: readonly HookStep[] = Object.values(HookStep) as HookStep[];
