/** The Slate-owned hook configuration produced after validating or adapting an input file. */
export interface HookScript {
  type: "command" | "prompt"
  command?: string
  prompt?: string
  matcher?: string
  timeout?: number
  loop_limit: null
  failClosed: false
}

export interface HookConfig {
  version: 1
  hooks: Record<string, HookScript[]>
}
