/**
 * Writing a piece of code out the way the model that will read it expects.
 *
 * Two things about a code block are model-specific and both are here. Line numbers: one family reads
 * them as a padded number followed by a bar, another as `L<n>:`, and a third as a padded number followed
 * by two spaces — and a sparse mode shows only every nth line, which is how a long file is made scannable
 * without dropping its numbering. Which one applies is decided by the session's formatting options rather
 * than by the caller, so every tool that writes code writes it the same way.
 *
 * The other is the tag the block is wrapped in, which carries the path, the language and whether the
 * whole file is shown — the metadata a reader needs to cite the code rather than describe it. A block
 * whose content is empty is written as an empty tag rather than as a tag around nothing.
 */

interface DetailedLine {
  readonly lineNumber?: number
  readonly text: string
}

interface CodeBlockFormattingOptions {
  readonly enableLineNumbers?: boolean
  readonly gpt5CodexCatN?: boolean
  readonly gpt5StyleLineNumbers?: boolean
  readonly sparseLineNumbers?: number
}

interface CodeBlock {
  readonly content: string
  readonly detailedLines?: readonly DetailedLine[]
  readonly extraAttributes?: Readonly<Record<string, unknown>>
  readonly filePath?: string
  readonly formattingOptions: CodeBlockFormattingOptions
  readonly isFullFile?: boolean
  readonly languageIdentifier?: string
  readonly startLineNumber: number
  readonly tag?: string
  readonly totalLineNumbersInFile?: number
}

interface FormatCodeBlockOptions {
  readonly addAmountOfOmittedLines?: boolean
}

export function formatCodeBlock(codeBlock: CodeBlock, options: FormatCodeBlockOptions): string {
  let result: string
  if (codeBlock.formattingOptions.enableLineNumbers === false) {
    result = codeBlock.detailedLines !== undefined
      ? codeBlock.detailedLines.map(line => line.text).join("\n")
      : codeBlock.content
  } else {
    result = addLineNumbers(
      codeBlock.formattingOptions,
      codeBlock.detailedLines ?? codeBlock.content,
      codeBlock.startLineNumber,
    )
  }
  // How much of the file is not shown, above and below the block, when the caller wants it said.
  if (options.addAmountOfOmittedLines === true && codeBlock.totalLineNumbersInFile !== undefined) {
    if (codeBlock.startLineNumber > 1) {
      const numHiddenLines = codeBlock.startLineNumber - 1
      result = `... ${numHiddenLines} ${numHiddenLines === 1 ? "line" : "lines"} not shown ...\n${result}`
    }
    const numLinesInCodeBlock = codeBlock.content.split("\n").length
    const endLineNumber = codeBlock.startLineNumber + numLinesInCodeBlock - 1
    if (codeBlock.totalLineNumbersInFile > endLineNumber) {
      const numHiddenLines = codeBlock.totalLineNumbersInFile - endLineNumber
      result = `${result}\n... ${numHiddenLines} ${numHiddenLines === 1 ? "line" : "lines"} not shown ...`
    }
  }
  if (codeBlock.tag !== undefined) {
    const isFullFileSection = codeBlock.isFullFile === true ? ' isFullFile="true"' : ""
    const languageIdentifierSection = codeBlock.languageIdentifier !== undefined
      ? ` language="${codeBlock.languageIdentifier}"`
      : ""
    const pathSection = codeBlock.filePath ? ` path="${codeBlock.filePath}"` : ""
    const extraAttributesSection = codeBlock.extraAttributes !== undefined
      ? Object.entries(codeBlock.extraAttributes).map(([key, value]) => ` ${key}="${value}"`).join("")
      : ""
    if (result.trim() === "") {
      result = `<${codeBlock.tag}${pathSection}${isFullFileSection}${languageIdentifierSection}${extraAttributesSection}></${codeBlock.tag}>`
    } else {
      result = `\n<${codeBlock.tag}${pathSection}${isFullFileSection}${languageIdentifierSection}${extraAttributesSection}>\n${result}\n</${codeBlock.tag}>\n`
    }
  }
  return result
}

function addLineNumbers(
  formattingOptions: CodeBlockFormattingOptions,
  code: string | readonly DetailedLine[],
  startLineNumber: number,
): string {
  if (formattingOptions.gpt5CodexCatN === true) return addLineNumbersPaddedWithSpaces(code, startLineNumber)
  if (formattingOptions.gpt5StyleLineNumbers === true) return addLineNumbersPrefixed(code, startLineNumber)
  return addLineNumbersPadded(code, startLineNumber, formattingOptions.sparseLineNumbers)
}

function addLineNumbersPaddedWithSpaces(code: string | readonly DetailedLine[], startLineNumber: number): string {
  if (typeof code === "string") {
    return code.split("\n").map((line, index) => {
      const paddedLineNumber = (startLineNumber + index).toString().padStart(6, " ")
      return `${paddedLineNumber}  ${line}`
    }).join("\n")
  }
  return code.map(line => Number.isInteger(line.lineNumber)
    ? `${line.lineNumber!.toString().padStart(6, " ")}  ${line.text}`
    : "...".padStart(6, " ")).join("\n")
}

/** A line whose number is not known is shown as an ellipsis rather than numbered wrongly. */
function addLineNumbersPadded(
  code: string | readonly DetailedLine[],
  startLineNumber: number,
  sparseN?: number,
): string {
  if (typeof code === "string") {
    return code.split("\n").map((line, index) => {
      const lineNumber = startLineNumber + index
      if (sparseN !== undefined && lineNumber % sparseN !== 0) return line
      return `${lineNumber.toString().padStart(6, " ")}|${line}`
    }).join("\n")
  }
  return code.map(line => {
    if (!Number.isInteger(line.lineNumber)) return "...".padStart(6, " ")
    if (sparseN !== undefined && line.lineNumber! % sparseN !== 0) return line.text
    return `${line.lineNumber!.toString().padStart(6, " ")}|${line.text}`
  }).join("\n")
}

function addLineNumbersPrefixed(code: string | readonly DetailedLine[], startLineNumber: number): string {
  if (typeof code === "string") {
    return code.split("\n").map((line, index) => `L${startLineNumber + index}:${line}`).join("\n")
  }
  return code.map(line => Number.isInteger(line.lineNumber) ? `L${line.lineNumber}:${line.text}` : "...").join("\n")
}
