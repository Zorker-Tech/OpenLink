/** Render commands the user attached as individually named prompt sections. */

export interface AttachedCommandForPrompt {
  readonly name: string;
  readonly content: string;
  readonly sourcePath?: string | undefined;
}

export interface AttachedCommandsTextContent {
  readonly type: "text";
  readonly text: string;
}

function commandSection(command: AttachedCommandForPrompt): string {
  return `

--- Command: ${command.name} ---
${command.content}
--- End Command ---`;
}

export function renderAttachedCommands(
  commands: readonly AttachedCommandForPrompt[],
): AttachedCommandsTextContent | undefined {
  if (commands.length === 0) return undefined;

  return {
    type: "text",
    text: `<slate_commands>${commands.map(commandSection).join("\n")}\n</slate_commands>`,
  };
}
