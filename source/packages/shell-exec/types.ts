/** Runtime identifiers used by the local shell selection policy. */
const SHELL_EXECUTOR_VALUES = {
  Zsh: "zsh",
  ZshLight: "zsh-light",
  Bash: "bash",
  PowerShell: "powershell",
  Naive: "naive",
} as const;

export const KnownShellExecutor = SHELL_EXECUTOR_VALUES;
export type KnownShellExecutor = (typeof SHELL_EXECUTOR_VALUES)[keyof typeof SHELL_EXECUTOR_VALUES];

const CHILD_PROCESS_ENVIRONMENT = [
  ["TERM", "dumb"],
  ["NO_COLOR", "1"],
  ["FORCE_COLOR", "0"],
  ["_ZO_DOCTOR", "0"],
] as const;

type ShellEnvironmentOverrides = {
  readonly TERM: "dumb";
  readonly NO_COLOR: "1";
  readonly FORCE_COLOR: "0";
  readonly _ZO_DOCTOR: "0";
};

export const SHELL_ENV_OVERRIDES = Object.fromEntries(CHILD_PROCESS_ENVIRONMENT) as ShellEnvironmentOverrides;
