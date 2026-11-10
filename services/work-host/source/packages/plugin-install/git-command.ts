import { gitExecFile } from "../git-core/git-exec.ts"

export type ExtraGitConfig = Readonly<Record<string, string | readonly string[]>>
export type ExtraGitConfigProvider =
  | ExtraGitConfig
  | (() => ExtraGitConfig | undefined)
  | undefined

export interface ExecGitNonInteractiveOptions {
  readonly cwd?: string | undefined
  readonly sshBatchMode?: boolean | undefined
  readonly extraGitConfig?: ExtraGitConfig | undefined
  readonly timeoutMs?: number | undefined
}

export function resolveExtraGitConfig(
  provider: ExtraGitConfigProvider,
): ExtraGitConfig | undefined {
  return typeof provider === "function" ? provider() : provider
}

export async function execGitNonInteractive(
  args: readonly string[],
  options?: ExecGitNonInteractiveOptions,
): Promise<{ stdout: string; stderr: string }> {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: undefined,
    VSCODE_GIT_ASKPASS_NODE: undefined,
    VSCODE_GIT_ASKPASS_MAIN: undefined,
    VSCODE_GIT_ASKPASS_EXTRA_ARGS: undefined,
    GCM_INTERACTIVE: "Never",
    GIT_CONFIG_NOSYSTEM: undefined,
  }
  if (options?.sshBatchMode === true) {
    const ssh = process.env.GIT_SSH_COMMAND?.trim() || "ssh"
    environment.GIT_SSH_COMMAND = `${ssh} -oBatchMode=yes`
  }
  if (options?.extraGitConfig !== undefined) {
    const entries = Object.entries(options.extraGitConfig).flatMap(([key, value]) =>
      Array.isArray(value)
        ? value.map(entry => [key, entry] as const)
        : [[key, value as string] as const]
    )
    environment.GIT_CONFIG_COUNT = String(entries.length)
    for (const [index, [key, value]] of entries.entries()) {
      environment[`GIT_CONFIG_KEY_${index}`] = key
      environment[`GIT_CONFIG_VALUE_${index}`] = value
    }
  }

  const policyArguments = [
    "-c",
    "credential.interactive=false",
    "-c",
    "core.fsmonitor=false",
  ]
  if (process.platform === "win32") {
    policyArguments.push("-c", "core.longpaths=true")
  }
  return gitExecFile("git", [...policyArguments, ...args], {
    cwd: options?.cwd,
    env: environment,
    ...(options?.timeoutMs === undefined
      ? {}
      : { timeout: options.timeoutMs, killSignal: "SIGTERM" }),
  })
}
