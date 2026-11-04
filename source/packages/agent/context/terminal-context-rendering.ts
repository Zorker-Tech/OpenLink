import { formatCodeBlock } from "../tools/core/formatting.ts"
import {
  SHELL_CHAR_HARD_LIMIT,
  limitTerminalOutput,
} from "./terminal-context-policy.ts"
import type {
  AttachedTerminalTextPart,
  SelectedTerminalForPrompt,
  SelectedTerminalSelectionForPrompt,
  TerminalFormattingOptions,
} from "./terminal-context-contracts.ts"

export function renderWholeTerminal(
  terminal: SelectedTerminalForPrompt,
  formattingOptions: TerminalFormattingOptions,
): AttachedTerminalTextPart {
  const attributes: Record<string, string> = {}
  if (terminal.title) attributes.title = terminal.title
  if (terminal.path) attributes.path = terminal.path
  const formatted = formatCodeBlock({
    content: terminal.content,
    filePath: "",
    startLineNumber: 1,
    formattingOptions: { ...formattingOptions, enableLineNumbers: false },
    tag: "terminal_output",
    ...(Object.keys(attributes).length > 0 ? { extraAttributes: attributes } : {}),
  } as unknown as Parameters<typeof formatCodeBlock>[0], { addAmountOfOmittedLines: false })
  return { type: "text", text: limitTerminalOutput(formatted, SHELL_CHAR_HARD_LIMIT, true).output }
}

export function renderTerminalSelection(
  selection: SelectedTerminalSelectionForPrompt,
  formattingOptions: TerminalFormattingOptions,
): AttachedTerminalTextPart {
  const startLine = selection.range?.start?.line ?? 1
  const endLine = selection.range?.end?.line ?? startLine
  const attributes: Record<string, string> = {}
  if (selection.title) attributes.title = selection.title
  if (selection.path) attributes.path = selection.path
  attributes.lines = `${startLine}-${endLine}`
  const formatted = formatCodeBlock({
    content: selection.content,
    filePath: "",
    startLineNumber: startLine,
    formattingOptions: { ...formattingOptions, enableLineNumbers: false },
    tag: "terminal_selection",
    extraAttributes: attributes,
  } as unknown as Parameters<typeof formatCodeBlock>[0], { addAmountOfOmittedLines: false })
  return { type: "text", text: formatted }
}
