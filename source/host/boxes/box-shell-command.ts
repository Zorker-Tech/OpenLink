/** Slate-owned fields needed to execute a host-originated command in a box. */
export interface HostShellArgsInput {
  command: string
  name: string
  workingDirectory: string
  toolCallId: string
}
