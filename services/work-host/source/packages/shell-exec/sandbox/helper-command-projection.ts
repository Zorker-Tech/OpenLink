/** Arguments passed to the helper: it consumes a policy file before the program begins. */
export function buildSandboxArgv(policyFilePath: string, program: string, programArgs: readonly string[]): readonly string[] {
  return ["--policy", policyFilePath, "--", program, ...programArgs]
}

/** Convert a shell invocation into the platform's command form; direct program invocations remain untouched. */
export function projectSandboxCommand(
  program: string,
  programArgs: readonly string[] = [],
  shell: boolean | string | undefined,
): { readonly command: string; readonly args: readonly string[] } {
  if (!shell) return { command: program, args: programArgs }

  const windows = process.platform === "win32"
  const shellProgram = typeof shell === "string" ? shell : windows ? "cmd.exe" : "/bin/sh"
  return {
    command: shellProgram,
    args: [windows ? "/c" : "-c", `${program} ${programArgs.join(" ")}`],
  }
}
