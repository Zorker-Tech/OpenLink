export interface SelectedGitDiffAttachment {
  readonly content?: string
  readonly fullContentLengthCharCount: number
}

export interface UserTextBlock {
  readonly type: "text"
  readonly text: string
}

export interface ParsedDiffFileBlock {
  readonly fileName: string
  readonly content: string
}

export interface ParsedDiffBlocks {
  readonly preface: string
  readonly files: readonly ParsedDiffFileBlock[]
}
