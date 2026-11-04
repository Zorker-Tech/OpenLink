import type { PromptNode } from "../../prompt-jsx/index.ts"

/** Prompt-level modes after the action protocol has been decoded. */
export type UserInfoMode =
  | "agent"
  | "ask"
  | "project"
  | "multitask"
  | { readonly kind: "unrecognized"; readonly value: unknown }

/** Model facts the prompt needs after provider-specific metadata has been translated. */
export interface UserInfoModelProfile {
  readonly suppressMcpContext: boolean
  readonly gpt56SkillBudget: boolean
  readonly mcpToolNameStyle: "pascal" | "snake"
}

/** Optional sections selected at the interop boundary from the active cloud model profile. */
export interface UserInfoCloudTestingSections {
  readonly gitAndSubmission?: PromptNode
  readonly testing?: PromptNode
  readonly computerUse?: PromptNode
}
