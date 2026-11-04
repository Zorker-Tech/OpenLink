export interface TerminalFormattingOptions {
  readonly enableLineNumbers?: boolean
  readonly gpt5CodexCatN?: boolean
  readonly gpt5StyleLineNumbers?: boolean
  readonly sparseLineNumbers?: number
}

export interface SelectedTerminalForPrompt {
  readonly title?: string | undefined
  readonly path?: string | undefined
  readonly content: string
}

export interface SelectedTerminalRange {
  readonly start?: { readonly line?: number | undefined } | undefined
  readonly end?: { readonly line?: number | undefined } | undefined
}

export interface SelectedTerminalSelectionForPrompt extends SelectedTerminalForPrompt {
  readonly range?: SelectedTerminalRange | undefined
}

export interface AttachedTerminalTextPart {
  readonly type: "text"
  readonly text: string
}
