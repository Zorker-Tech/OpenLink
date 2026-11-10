/**
 * The code selections the user attached, inlined or spilled.
 *
 * A selection is small enough to inline most of the time, and then it is written out as a tagged block
 * with its line range — the metadata a reader needs to cite it. A selection larger than the inline limit
 * is written to a file instead, and the block says so and names the file, because a message that simply
 * dropped the selection would look like the user attached nothing.
 *
 * A notebook's selection is not line-numbered even when the session asks for numbers: a notebook's own
 * cells carry the references, and numbering the selection again would point at the wrong lines.
 */

import { writeCodeSelectionToFile } from "./code-selection-spill.ts"
import {
  inlineSelectionContent,
  lineRangeOfSelection,
  selectionNeedsFile,
  spilledSelectionContent,
} from "./code-selection-content-projections.ts"
import type {
  RenderSelectedCodeSelectionsArgs,
  RenderedCodeSelections,
  SelectedCodeSelectionForPrompt,
} from "./code-selection-context-contracts.ts"

export type {
  CodeSelectionFormattingOptions,
  CodeSelectionTextContent,
  RenderSelectedCodeSelectionsArgs,
  RenderedCodeSelections,
  SelectedCodeSelectionForPrompt,
} from "./code-selection-context-contracts.ts"

interface RenderedSelection {
  readonly content: ReturnType<typeof inlineSelectionContent>
  readonly documentInfo?: { readonly path: string } | undefined
}

async function renderOneSelection(
  args: RenderSelectedCodeSelectionsArgs,
  selection: SelectedCodeSelectionForPrompt,
  index: number,
): Promise<RenderedSelection> {
  const lineRange = lineRangeOfSelection(selection)
  if (selectionNeedsFile(selection, args.enableLongCodeSelectionSpillToFile)) {
    const destination = await writeCodeSelectionToFile({
      ctx: args.ctx,
      content: selection.content,
      originalPath: selection.path,
      startLine: lineRange.start,
      endLine: lineRange.end,
      index,
      requestContext: args.requestContext,
      resourceAccessor: args.resourceAccessor,
    })
    if (destination !== undefined) {
      return {
        content: spilledSelectionContent(selection, lineRange, destination.path),
        documentInfo: destination,
      }
    }
  }
  return {
    content: inlineSelectionContent(selection, lineRange, args.formattingOptions),
  }
}

export async function renderSelectedCodeSelections({
  ctx,
  codeSelections,
  formattingOptions,
  enableLongCodeSelectionSpillToFile,
  requestContext,
  resourceAccessor,
}: RenderSelectedCodeSelectionsArgs): Promise<RenderedCodeSelections> {
  const renderedSelections: RenderedSelection[] = []
  for (const [index, selection] of codeSelections.entries()) {
    renderedSelections.push(await renderOneSelection({
      ctx,
      codeSelections,
      formattingOptions,
      enableLongCodeSelectionSpillToFile,
      requestContext,
      resourceAccessor,
    }, selection, index))
  }
  return {
    attachedFilesContent: renderedSelections.map(selection => selection.content),
    documentInfos: renderedSelections.flatMap(selection =>
      selection.documentInfo === undefined ? [] : [selection.documentInfo]),
  }
}
