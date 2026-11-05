export type MultitaskActionKind = "start-self-fork" | "execute-plan-in-parallel"

interface MultitaskActionPromptOptions {
  readonly taskToolName?: string
}

const FORK_HANDOFF = "You are the continuation worker. Continue the assigned task."

function toolInstruction(taskToolName: string | undefined): string {
  return taskToolName === undefined ? "your subagent tool" : `the ${taskToolName} tool`
}

function selfForkReminder(taskToolName: string | undefined): string {
  return `<system_reminder>
The user chose Start Multitasking.

Launch one background child of this agent using ${toolInstruction(taskToolName)}. Set runInBackground to true and resume to "self". Give it this exact handoff line: "${FORK_HANDOFF}"

When you later receive that exact handoff line, continue the assigned work and do not launch another child. If the handoff line is absent, stop now: do not keep planning in the foreground and do not send another reply to the user.
</system_reminder>`
}

function parallelPlanReminder(): string {
  return `<system_reminder>
The user chose Build in Parallel.

Use the attached plan as the source of truth and leave the plan file unchanged. Its todos already exist: do not duplicate them. Mark the first item in progress, then keep working until every item is complete.

<build_with_multitask_instructions>
First read the plan and group its work by prerequisites. When you launch an agent, point it to the relevant plan steps and provide only extra context those steps do not contain; do not paste the full plan into its prompt.

Create a separate top-level background agent for each phase. Start ready, independent phases concurrently. Hold a phase until the work it depends on is complete.

If several agents implement the plan and it reserves end-to-end checks for the end, ask implementation agents to skip those checks and reserve a later phase for testing. If one agent owns implementation, that agent also runs its tests.

Keep these parallel-execution rules active until the user exits multitask mode. For this explicit request, they take precedence over general guidance against sibling agents.
</build_with_multitask_instructions>
</system_reminder>`
}

export function synthesizeMultitaskActionPrompt(
  action: MultitaskActionKind | undefined,
  { taskToolName }: MultitaskActionPromptOptions = {},
): string | undefined {
  if (action === "start-self-fork") return selfForkReminder(taskToolName)
  if (action === "execute-plan-in-parallel") return parallelPlanReminder()
  return undefined
}
