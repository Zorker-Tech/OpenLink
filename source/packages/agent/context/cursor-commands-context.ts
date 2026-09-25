/**
 * The saved commands the user attached.
 *
 * A command is a stored prompt the user invokes by name, and attaching one means "run this". It is
 * inlined with a header naming it and a footer closing it, because the command's own text may contain
 * anything — including something that looks like the end of the block — and the boundary is what tells
 * the agent where the command stops.
 */

export interface SelectedCursorCommandForPrompt {
  readonly name: string
  readonly content: string
}

export interface CursorCommandsTextContent {
  readonly type: "text"
  readonly text: string
}

export function renderSelectedCursorCommands(
  cursorCommands: readonly SelectedCursorCommandForPrompt[],
): CursorCommandsTextContent | undefined {
  if (cursorCommands.length === 0) return undefined
  const commandsText = cursorCommands.map(command => `

--- Command: ${command.name} ---
${command.content}
--- End Command ---`).join("\n")
  if (!commandsText) return undefined
  return {
    type: "text",
    text: `<slate_commands>${commandsText}
</slate_commands>`,
  }
}
