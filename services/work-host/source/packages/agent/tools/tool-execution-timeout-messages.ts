export function buildToolCallExecutionTimedOutMessage(args: {
  readonly toolName: string
  readonly executionTimeoutMs: number
}): string {
  const shellGuidance = args.toolName.toLowerCase() === "shell"
    ? " For long-running commands, set block_until_ms to 0 or a short duration, then check the command output after this call returns."
    : ""
  if (args.executionTimeoutMs === 0) {
    return `The ${args.toolName} tool call could not start because preparing its execution context exhausted the per-call limit. The host may be slow or overloaded.${shellGuidance}`
  }
  const seconds = Math.round(args.executionTimeoutMs / 1_000)
  return `The ${args.toolName} tool call exceeded its ${seconds}-second limit and was stopped. The host may be overloaded, or the operation may need a higher per-call limit.${shellGuidance}`
}
