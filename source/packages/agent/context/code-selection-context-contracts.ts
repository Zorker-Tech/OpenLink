import type { Context } from "../../context/context.ts"
import type { CodeSelectionResourceAccessor } from "./code-selection-spill.ts"
import type { AttachmentPathRequestContext } from "./path-trust.ts"

interface CodeSelectionRange {
  readonly start?: { readonly line?: number | undefined } | undefined
  readonly end?: { readonly line?: number | undefined } | undefined
}

export interface SelectedCodeSelectionForPrompt {
  readonly path: string
  readonly content: string
  readonly range?: CodeSelectionRange | undefined
}

export interface CodeSelectionFormattingOptions {
  readonly enableLineNumbers?: boolean
  readonly gpt5CodexCatN?: boolean
  readonly gpt5StyleLineNumbers?: boolean
  readonly sparseLineNumbers?: number
}

export interface CodeSelectionTextContent {
  readonly type: "text"
  readonly text: string
}

export interface RenderSelectedCodeSelectionsArgs {
  readonly ctx: Context
  readonly codeSelections: readonly SelectedCodeSelectionForPrompt[]
  readonly formattingOptions: CodeSelectionFormattingOptions
  readonly enableLongCodeSelectionSpillToFile: boolean
  readonly requestContext: AttachmentPathRequestContext | undefined
  readonly resourceAccessor: CodeSelectionResourceAccessor | undefined
}

export interface RenderedCodeSelections {
  readonly attachedFilesContent: CodeSelectionTextContent[]
  readonly documentInfos: Array<{ readonly path: string }>
}
