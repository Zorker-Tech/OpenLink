/**
 * The terminal output the user attached, as blocks the model can read.
 *
 * A terminal is attached either whole or as a selection of lines, and the two are tagged differently so
 * the model can tell a full session from a passage of one. Line numbers are never added: terminal output
 * carries its own line references and numbering it again would mislead. The title and the path travel as
 * attributes, because they are what identifies which terminal this was.
 *
 * A whole terminal is capped from both ends — the start says how the session began and the end says what
 * it last did — while a selection is passed through as it is, since the user chose the lines.
 */

import { formatCodeBlock } from "../tools/core/formatting.ts"

interface TerminalFormattingOptions {
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

export interface SelectedTerminalSelectionForPrompt {
  readonly title?: string | undefined
  readonly path?: string | undefined
  readonly content: string
  readonly range?: SelectedTerminalRange | undefined
}

export interface AttachedTerminalTextPart {
  readonly type: "text"
  readonly text: string
}

const SHELL_CHAR_HARD_LIMIT = 20_000

function truncateOutput(output: string, maxLength: number, frontAndBack: boolean): { output: string; truncated: boolean } {
  if (output.length <= maxLength) return { output, truncated: false }
  if (frontAndBack) {
    const halfLength = Math.floor(maxLength / 2)
    return {
      output: output.substring(0, halfLength) + "\n\n... (output truncated) ...\n\n" + output.substring(output.length - halfLength),
      truncated: true,
    }
  }
  return { output: output.substring(0, maxLength) + "\n\n... (output truncated)", truncated: true }
}

export function renderSelectedTerminalContext(
  terminals: readonly SelectedTerminalForPrompt[],
  terminalSelections: readonly SelectedTerminalSelectionForPrompt[],
  formattingOptions: TerminalFormattingOptions,
): AttachedTerminalTextPart[] {
  const attachedFilesContent: AttachedTerminalTextPart[] = []
  for (const terminal of terminals) {
    const extraAttributes: Record<string, string> = {}
    if (terminal.title) extraAttributes.title = terminal.title
    if (terminal.path) extraAttributes.path = terminal.path
    const formattedContent = formatCodeBlock({
      content: terminal.content,
      filePath: "",
      startLineNumber: 1,
      formattingOptions: { ...formattingOptions, enableLineNumbers: false },
      tag: "terminal_output",
      ...(Object.keys(extraAttributes).length > 0 ? { extraAttributes } : {}),
    } as unknown as Parameters<typeof formatCodeBlock>[0], {
      addAmountOfOmittedLines: false,
    })
    attachedFilesContent.push({ type: "text", text: truncateOutput(formattedContent, SHELL_CHAR_HARD_LIMIT, true).output })
  }
  for (const terminalSelection of terminalSelections) {
    const startLine = terminalSelection.range?.start?.line ?? 1
    const endLine = terminalSelection.range?.end?.line ?? startLine
    const extraAttributes: Record<string, string> = {}
    if (terminalSelection.title) extraAttributes.title = terminalSelection.title
    if (terminalSelection.path) extraAttributes.path = terminalSelection.path
    extraAttributes.lines = `${startLine}-${endLine}`
    const formattedContent = formatCodeBlock({
      content: terminalSelection.content,
      filePath: "",
      startLineNumber: startLine,
      formattingOptions: { ...formattingOptions, enableLineNumbers: false },
      tag: "terminal_selection",
      extraAttributes,
    } as unknown as Parameters<typeof formatCodeBlock>[0], {
      addAmountOfOmittedLines: false,
    })
    attachedFilesContent.push({ type: "text", text: formattedContent })
  }
  return attachedFilesContent
}
