/** Model-aware rendering for source excerpts and code blocks. */

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

type LineSource = string | readonly DetailedLine[]
type NumberStyle = "barred" | "codex" | "prefixed"

export function formatCodeBlock(block: CodeBlock, options: FormatCodeBlockOptions): string {
  const excerpt = addOmittedLineNotes(
    formatExcerpt(block),
    block,
    options.addAmountOfOmittedLines === true,
  )
  return block.tag === undefined ? excerpt : wrapInTag(block, excerpt)
}

function formatExcerpt(block: CodeBlock): string {
  const source = block.detailedLines ?? block.content
  if (block.formattingOptions.enableLineNumbers === false) return joinSourceText(source)
  return numberSourceLines(source, block.startLineNumber, numberStyle(block.formattingOptions), block.formattingOptions.sparseLineNumbers)
}

function joinSourceText(source: LineSource): string {
  return typeof source === "string" ? source : source.map(line => line.text).join("\n")
}

function numberStyle(options: CodeBlockFormattingOptions): NumberStyle {
  if (options.gpt5CodexCatN === true) return "codex"
  if (options.gpt5StyleLineNumbers === true) return "prefixed"
  return "barred"
}

function numberSourceLines(source: LineSource, firstLine: number, style: NumberStyle, sparseInterval?: number): string {
  const lines = typeof source === "string"
    ? source.split("\n").map((text, index) => ({ lineNumber: firstLine + index, text }))
    : source
  return lines.map(line => numberOneLine(line, style, sparseInterval)).join("\n")
}

function numberOneLine(line: DetailedLine, style: NumberStyle, sparseInterval?: number): string {
  const lineNumber = line.lineNumber
  if (typeof lineNumber !== "number" || !Number.isInteger(lineNumber)) {
    return style === "prefixed" ? "..." : "...".padStart(6, " ")
  }
  if (style === "prefixed") return `L${lineNumber}:${line.text}`
  if (style === "codex") return `${lineNumber.toString().padStart(6, " ")}  ${line.text}`
  if (sparseInterval !== undefined && lineNumber % sparseInterval !== 0) return line.text
  return `${lineNumber.toString().padStart(6, " ")}|${line.text}`
}

function addOmittedLineNotes(text: string, block: CodeBlock, enabled: boolean): string {
  const total = block.totalLineNumbersInFile
  if (!enabled || total === undefined) return text

  let result = text
  if (block.startLineNumber > 1) {
    result = `${omissionNote(block.startLineNumber - 1)}\n${result}`
  }

  const visibleLineCount = block.content.split("\n").length
  const lastVisibleLine = block.startLineNumber + visibleLineCount - 1
  if (total > lastVisibleLine) {
    result = `${result}\n${omissionNote(total - lastVisibleLine)}`
  }
  return result
}

function omissionNote(count: number): string {
  return `... ${count} ${count === 1 ? "line" : "lines"} not shown ...`
}

function wrapInTag(block: CodeBlock, content: string): string {
  const attributes = tagAttributes(block)
  if (content.trim() === "") return `<${block.tag}${attributes}></${block.tag}>`
  return `\n<${block.tag}${attributes}>\n${content}\n</${block.tag}>\n`
}

function tagAttributes(block: CodeBlock): string {
  const attributes: string[] = []
  if (block.filePath) attributes.push(`path="${block.filePath}"`)
  if (block.isFullFile === true) attributes.push('isFullFile="true"')
  if (block.languageIdentifier !== undefined) attributes.push(`language="${block.languageIdentifier}"`)
  for (const [name, value] of Object.entries(block.extraAttributes ?? {})) {
    attributes.push(`${name}="${value}"`)
  }
  return attributes.length === 0 ? "" : ` ${attributes.join(" ")}`
}
