import type { LocalExecMessage, SlateLocalToolRequest } from "./local-tool-permission-contracts.ts";

function forwardSlashes(path: string): string {
  return path.replace(/\\/g, "/");
}

function terminalDirectory(path: string): string {
  return forwardSlashes(path).replace(/\/+$/, "");
}

export function normalizeLocalToolResourcePath(path: string | undefined): string | undefined {
  return path === undefined || path.length === 0 ? undefined : forwardSlashes(path);
}

export function slateTerminalFilePath(terminalsFolder: string, shellId: string): string | undefined {
  if (shellId.length === 0) return undefined;
  return `${terminalDirectory(terminalsFolder)}/${shellId}.txt`;
}

export function isTerminalFile(path: string, terminalsFolder: string): boolean {
  const directory = terminalDirectory(terminalsFolder);
  if (directory.length === 0) return false;
  const relativeName = forwardSlashes(path).slice(directory.length + 1);
  if (!forwardSlashes(path).startsWith(`${directory}/`)) return false;
  return relativeName.length > 0 && relativeName.indexOf("/") < 0 && relativeName.endsWith(".txt");
}

type RequestProjector = (value: Record<string, unknown>, terminalsFolder: string) => SlateLocalToolRequest;

function commandRequest(value: Record<string, unknown>, terminalsFolder: string, outlivesScope: boolean): SlateLocalToolRequest {
  return {
    action: "run-command",
    target: value.command as string,
    resourcePath: terminalsFolder,
    ...(outlivesScope ? { outlivesScope: true } : {}),
  };
}

function readRequest(value: Record<string, unknown>, terminalsFolder: string): SlateLocalToolRequest {
  const path = value.path as string;
  return {
    action: "read-file",
    target: path,
    ...(isTerminalFile(path, terminalsFolder) ? { attachToResourcePath: terminalsFolder } : {}),
  };
}

const requestProjectors: Readonly<Record<string, RequestProjector>> = {
  shellStreamArgs: (value, folder) => commandRequest(value, folder, Boolean(value.isBackground)),
  backgroundShellSpawnArgs: (value, folder) => commandRequest(value, folder, true),
  forceBackgroundShellArgs: (_value, folder) => ({
    action: "run-command",
    target: "a command already running",
    attachToResourcePath: folder,
    outlivesScope: true,
  }),
  writeShellStdinArgs: (value) => ({ action: "send-input", target: value.chars as string }),
  readArgs: readRequest,
  redactedReadArgs: readRequest,
  lsArgs: (value) => ({ action: "list-directory", target: value.path as string }),
};

export function describeLocalExec(
  serverMessage: { readonly message: LocalExecMessage },
  terminalsFolder: string,
): SlateLocalToolRequest | undefined {
  const message = serverMessage.message;
  const kind = message.case ?? "";
  if (!Object.hasOwn(requestProjectors, kind)) return undefined;
  const project = requestProjectors[kind];
  return project === undefined ? undefined : project(message.value, terminalsFolder);
}
