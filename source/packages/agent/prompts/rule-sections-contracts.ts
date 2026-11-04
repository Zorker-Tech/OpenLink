/** The prompt fields needed to describe a rule without carrying its wire message into the renderer. */
export interface PromptRuleDescriptor {
  readonly fullPath: string
  readonly content?: string | null | undefined
  readonly source?: "unspecified" | "team" | "user" | undefined
  readonly environments?: readonly string[] | undefined
  readonly disabledEnvironments?: readonly string[] | undefined
  readonly type?: {
    readonly type?: {
      readonly case?: string | undefined
      readonly value?: unknown
    } | undefined
  } | undefined
}
