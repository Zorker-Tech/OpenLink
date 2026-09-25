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

import type { SimulatedMsgReason } from "../proto/generated/agent/v1/agent_pb.ts"
import type { SelectedContext } from "../proto/generated/agent/v1/selected_context_pb.ts"
import { synthesizeGitActionPrompt } from "./git-action-prompt.ts"
import { synthesizeMultitaskActionPrompt } from "./multitask-action-prompt.ts"
import { getTaskToolName, type TaskToolModelInfo } from "./tools/task-tool-name.ts"

export interface SimulatedMessagePromptText {
  readonly type: "text"
  readonly text: string
}

export interface RenderSimulatedMessagePromptsArgs {
  readonly selectedContext: SelectedContext
  readonly simulatedMsgReason: SimulatedMsgReason
  readonly modelInfo?: TaskToolModelInfo | undefined
  readonly environmentParamForSubagent?: boolean | undefined
  readonly babysitV2Prompt?: boolean | undefined
  readonly enablePrCreationForgeGuidance?: boolean | undefined
}

export function renderSimulatedMessagePrompts({
  selectedContext,
  simulatedMsgReason,
  modelInfo,
  environmentParamForSubagent,
  babysitV2Prompt,
  enablePrCreationForgeGuidance,
}: RenderSimulatedMessagePromptsArgs): SimulatedMessagePromptText[] {
  const prompts = [
    synthesizeGitActionPrompt({
      selectedContext,
      simulatedMsgReason,
      environmentParamForSubagent: environmentParamForSubagent === true,
      babysitV2Prompt: babysitV2Prompt === true,
      enablePrCreationForgeGuidance: enablePrCreationForgeGuidance === true,
    }),
    synthesizeMultitaskActionPrompt(
      simulatedMsgReason,
      modelInfo !== undefined ? { taskToolName: getTaskToolName(modelInfo) } : {},
    ),
  ].filter(prompt => prompt !== undefined)
  return prompts.map(prompt => ({
    type: "text",
    text: prompt,
  }))
}
