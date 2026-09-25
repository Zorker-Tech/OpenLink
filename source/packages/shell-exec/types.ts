/**
 * The shells this platform can drive, and the environment a command runs in.
 *
 * A shell is named for the implementation that drives it rather than for the binary, since two entries may
 * run the same program differently — one snapshotting a full interactive state and one taking a lighter
 * version of the same. The environment overrides are what a command is given regardless of the user's own
 * settings: output that a terminal would colorize is written plainly, because nothing here is a terminal.
 */

export enum KnownShellExecutor { Zsh = "zsh", ZshLight = "zsh-light", Bash = "bash", PowerShell = "powershell", Naive = "naive" }
export const SHELL_ENV_OVERRIDES = { TERM: "dumb", NO_COLOR: "1", FORCE_COLOR: "0", _ZO_DOCTOR: "0" } as const
