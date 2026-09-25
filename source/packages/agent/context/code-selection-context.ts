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

import { formatCodeBlock } from "../tools/core/formatting.ts"
import type { Context } from "../../context/context.ts"
import type { AttachmentPathRequestContext } from "./path-trust.ts"
import { writeCodeSelectionToFile, type CodeSelectionResourceAccessor } from "./code-selection-spill.ts"

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

const CODE_SELECTION_INLINE_LIMIT = 20_000

export async function renderSelectedCodeSelections({
  ctx,
  codeSelections,
  formattingOptions,
  enableLongCodeSelectionSpillToFile,
  requestContext,
  resourceAccessor,
}: RenderSelectedCodeSelectionsArgs): Promise<RenderedCodeSelections> {
  const attachedFilesContent: CodeSelectionTextContent[] = []
  const documentInfos: Array<{ readonly path: string }> = []
  for (let index = 0; index < codeSelections.length; index += 1) {
    const codeSelection = codeSelections[index]!
    const startLine = codeSelection.range?.start?.line ?? 1
    const endLine = codeSelection.range?.end?.line ?? startLine
    const isJupyterNotebook = codeSelection.path.endsWith(".ipynb")
    if (enableLongCodeSelectionSpillToFile && codeSelection.content.length > CODE_SELECTION_INLINE_LIMIT) {
      const spilled = await writeCodeSelectionToFile({
        ctx,
        content: codeSelection.content,
        originalPath: codeSelection.path,
        startLine,
        endLine,
        index,
        requestContext,
        resourceAccessor,
      })
      if (spilled !== undefined) {
        documentInfos.push(spilled)
        attachedFilesContent.push({
          type: "text",
          text: `<code_selection lines="${startLine}-${endLine}" source="${codeSelection.path}" file="${spilled.path}">
\tThe selection from \`${codeSelection.path}\` (lines ${startLine}-${endLine}) was too large to inline. Its full contents have been saved to \`${spilled.path}\`; read that file when you need the selection.
</code_selection>`,
        })
        continue
      }
    }
    attachedFilesContent.push({
      type: "text",
      text: formatCodeBlock({
        content: codeSelection.content,
        filePath: codeSelection.path,
        startLineNumber: startLine,
        totalLineNumbersInFile: undefined,
        formattingOptions: {
          ...formattingOptions,
          enableLineNumbers: formattingOptions.enableLineNumbers !== false && !isJupyterNotebook,
        },
        tag: "code_selection",
        extraAttributes: { lines: `${startLine}-${endLine}` },
      } as unknown as Parameters<typeof formatCodeBlock>[0], {
        addAmountOfOmittedLines: false,
      }),
    })
  }
  return { attachedFilesContent, documentInfos }
}
