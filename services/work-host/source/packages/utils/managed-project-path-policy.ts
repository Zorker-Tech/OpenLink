import type { ManagedProjectPathMatch } from "./managed-project-path-contracts.ts";

function pathComponents(value: string): string[] {
  return value.split(/[/\\]/).filter((component) => component.length > 0);
}

function findWorkspaceArea(value: string, directoryName: string): ManagedProjectPathMatch | null {
  const components = pathComponents(value);
  for (let offset = 0; offset + 3 < components.length; offset += 1) {
    if (
      components[offset] === ".slate"
      && components[offset + 1] === "projects"
      && components[offset + 3] === directoryName
    ) {
      return {
        workspaceId: components[offset + 2] as string,
        nestedParts: components.slice(offset + 4),
      };
    }
  }
  return null;
}

export function isAbsolutePath(filePath: string): boolean {
  return filePath.startsWith("/")
    || /^[a-zA-Z]:[\\/]/.test(filePath)
    || filePath.startsWith("\\\\");
}

export function hasManagedTranscriptDirectory(value: string): boolean {
  return findWorkspaceArea(value, "agent-transcripts") !== null;
}

export function isManagedTerminalDirectory(value: string): boolean {
  const match = findWorkspaceArea(value, "terminals");
  return match !== null && match.nestedParts.length === 0;
}

export function isManagedToolOutput(value: string): boolean {
  const match = findWorkspaceArea(value, "agent-tools");
  return match !== null
    && match.nestedParts.length === 1
    && match.nestedParts[0]?.endsWith(".txt") === true;
}

export function terminalIdFromManagedPath(filePath: string): { id: number } | null {
  const match = findWorkspaceArea(filePath, "terminals");
  if (match === null || match.nestedParts.length !== 1) return null;
  const file = /^(\d+)\.txt$/.exec(match.nestedParts[0] as string);
  if (file?.[1] === undefined) return null;
  const id = Number.parseInt(file[1], 10);
  return Number.isNaN(id) ? null : { id };
}

export function hasManagedTerminalFile(filePath: string): boolean {
  return terminalIdFromManagedPath(filePath) !== null;
}
