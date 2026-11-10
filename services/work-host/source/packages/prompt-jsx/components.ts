import { Fragment, jsx, type PromptElement, type PromptProps } from "./element.ts"

type MessageRole = "System" | "User" | "Assistant" | "Tool"

function roleComponent(role: MessageRole): (props: PromptProps) => PromptElement {
  return props => jsx(role, props)
}

export const System = roleComponent("System")
export const User = roleComponent("User")
export const Assistant = roleComponent("Assistant")
export const Tool = roleComponent("Tool")

export function Conversation(props: PromptProps): PromptElement {
  return jsx(Fragment, props)
}

export const builtinComponents = {
  System,
  User,
  Assistant,
  Tool,
  Conversation,
  Fragment,
}
