/**
 * The components that decide what a prompt *is* to the model.
 *
 * Everything else in a prompt is content; these four name the speaker. A prompt that renders through
 * them becomes a conversation (system instruction, user turn, assistant turn, tool result) rather
 * than one long string, which is what lets the platform attach tool results to the call that produced
 * them and keep the instruction separate from the request.
 */

import { Fragment, jsx, type PromptElement, type PromptProps } from "./element.ts"

export const System = (props: PromptProps): PromptElement => jsx("System", props)
export const User = (props: PromptProps): PromptElement => jsx("User", props)
export const Assistant = (props: PromptProps): PromptElement => jsx("Assistant", props)
export const Tool = (props: PromptProps): PromptElement => jsx("Tool", props)
export const Conversation = (props: PromptProps): PromptElement => jsx(Fragment, props)

export const builtinComponents = {
  System,
  User,
  Assistant,
  Tool,
  Conversation,
  Fragment,
}
