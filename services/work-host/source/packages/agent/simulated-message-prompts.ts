/**
 * The instructions a wake-up that the user did not write carries.
 *
 * A turn can be started by the platform rather than by the user — a git action taken from the diff view, a
 * goal continuing, a split of work into pull requests — and each of those needs the model told what it is
 * being asked to do. The reason the turn was started is what selects the instruction, and two sources can
 * have something to say for the same reason, so both are asked and whatever they produce is carried in
 * order. Nothing is invented for a reason neither of them knows: a wake-up with no instruction produces no
 * content, and the caller is left with an empty list rather than a placeholder.
 *
 * The text is content parts rather than a string because that is what a user message is made of, and the
 * tool the subagent would be launched with is passed through, so the instruction names the tool this
 * session actually has instead of a name the model would have to guess at.
 */

import type { GitActionPromptInput } from "./git-action-prompt-contracts.ts"
import { synthesizeGitActionPrompt } from "./git-action-prompt.ts"
import { synthesizeMultitaskActionPrompt, type MultitaskActionKind } from "./multitask-action-prompt.ts"
import { getTaskToolName, type TaskToolModelInfo } from "./tools/task-tool-name.ts"

export interface SimulatedMessagePromptText {
  readonly type: "text"
  readonly text: string
}

export interface RenderSimulatedMessagePromptsArgs {
  readonly gitAction?: GitActionPromptInput | undefined
  readonly multitaskAction?: MultitaskActionKind | undefined
  readonly modelInfo?: TaskToolModelInfo | undefined
}

export function renderSimulatedMessagePrompts({
  gitAction,
  multitaskAction,
  modelInfo,
}: RenderSimulatedMessagePromptsArgs): SimulatedMessagePromptText[] {
  const prompts = [
    gitAction === undefined ? undefined : synthesizeGitActionPrompt(gitAction),
    synthesizeMultitaskActionPrompt(
      multitaskAction,
      modelInfo !== undefined ? { taskToolName: getTaskToolName(modelInfo) } : {},
    ),
  ].filter(prompt => prompt !== undefined)
  return prompts.map(prompt => ({
    type: "text",
    text: prompt,
  }))
}
