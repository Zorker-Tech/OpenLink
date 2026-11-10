import { formatCodeBlock } from "../tools/core/formatting.ts"
import type {
  CodeSelectionFormattingOptions,
  CodeSelectionTextContent,
  SelectedCodeSelectionForPrompt,
} from "./code-selection-context-contracts.ts"

export interface CodeSelectionLineRange {
  readonly start: number
  readonly end: number
}

const INLINE_SELECTION_LIMIT = 20_000

export function lineRangeOfSelection(selection: SelectedCodeSelectionForPrompt): CodeSelectionLineRange {
  const start = selection.range?.start?.line ?? 1
  return { start, end: selection.range?.end?.line ?? start }
}

export function selectionNeedsFile(selection: SelectedCodeSelectionForPrompt, spillEnabled: boolean): boolean {
  return spillEnabled && selection.content.length > INLINE_SELECTION_LIMIT
}

export function inlineSelectionContent(
  selection: SelectedCodeSelectionForPrompt,
  lineRange: CodeSelectionLineRange,
  formattingOptions: CodeSelectionFormattingOptions,
): CodeSelectionTextContent {
  const isNotebook = selection.path.endsWith(".ipynb")
  return {
    type: "text",
    text: formatCodeBlock({
      content: selection.content,
      filePath: selection.path,
      startLineNumber: lineRange.start,
      totalLineNumbersInFile: undefined,
      formattingOptions: {
        ...formattingOptions,
        enableLineNumbers: formattingOptions.enableLineNumbers !== false && !isNotebook,
      },
      tag: "code_selection",
      extraAttributes: { lines: `${lineRange.start}-${lineRange.end}` },
    } as unknown as Parameters<typeof formatCodeBlock>[0], {
      addAmountOfOmittedLines: false,
    }),
  }
}

export function spilledSelectionContent(
  selection: SelectedCodeSelectionForPrompt,
  lineRange: CodeSelectionLineRange,
  destinationPath: string,
): CodeSelectionTextContent {
  return {
    type: "text",
    text: `<code_selection lines="${lineRange.start}-${lineRange.end}" source="${selection.path}" file="${destinationPath}">
\tThe selection from \`${selection.path}\` (lines ${lineRange.start}-${lineRange.end}) was too large to inline. Its full contents have been saved to \`${destinationPath}\`; read that file when you need the selection.
</code_selection>`,
  }
}
