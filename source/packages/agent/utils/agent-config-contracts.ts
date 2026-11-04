export type BackgroundAgentSource = "named-agent" | "automated-fix" | "other"

export type CommandClassifierSucceededResult = {
  readonly kind: "classification-succeeded"
  readonly suggestedSandboxMode: string
  readonly commands: readonly {
    readonly name: string
    readonly arguments: string[]
    readonly suggestedAllowlistEntry: string
    readonly subcommandTokens: string[]
  }[]
}

export type CommandClassifierInternalResult =
  | CommandClassifierSucceededResult
  | { readonly kind: string }
