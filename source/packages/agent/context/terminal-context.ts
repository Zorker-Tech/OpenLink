import { renderTerminalSelection, renderWholeTerminal } from "./terminal-context-rendering.ts"
import type {
  AttachedTerminalTextPart,
  SelectedTerminalForPrompt,
  SelectedTerminalSelectionForPrompt,
  TerminalFormattingOptions,
} from "./terminal-context-contracts.ts"

export type {
  AttachedTerminalTextPart,
  SelectedTerminalForPrompt,
  SelectedTerminalRange,
  SelectedTerminalSelectionForPrompt,
  TerminalFormattingOptions,
} from "./terminal-context-contracts.ts"

export function renderSelectedTerminalContext(
  terminals: readonly SelectedTerminalForPrompt[],
  terminalSelections: readonly SelectedTerminalSelectionForPrompt[],
  formattingOptions: TerminalFormattingOptions,
): AttachedTerminalTextPart[] {
  const parts = terminals.map((terminal) => renderWholeTerminal(terminal, formattingOptions))
  parts.push(...terminalSelections.map((selection) => renderTerminalSelection(selection, formattingOptions)))
  return parts
}
