export interface ParsedDiffFile {
  readonly fileName: string
  readonly content: string
}

export interface ParsedDiff {
  readonly preface: string
  readonly files: readonly ParsedDiffFile[]
}

export interface DiffTruncationOptions {
  readonly originalContent?: string
  readonly truncationNotice?: string
  readonly skipSorting?: boolean
}

export const DIFF_NO_BUDGET_MESSAGE = "[diff omitted due to size constraints]"
export const DEFAULT_DIFF_TRUNCATION_NOTICE = "\n\n[diff truncated due to size]"
