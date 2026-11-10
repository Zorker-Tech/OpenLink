/** Running a command for the computer-use surface, with a timeout and an environment of its own. */
import { execFile, type ExecFileOptionsWithStringEncoding } from "node:child_process";

/** How long a command may run when the caller does not say. */
const DEFAULT_TIMEOUT_MS = 30_000;

/** The encoding the output is read as, so a caller is handed text rather than bytes. */
const STDOUT_ENCODING = "utf8";

export interface ExecOptions { timeoutMs?: number; env?: NodeJS.ProcessEnv }

/** The environment a command runs in: this process's own, with whatever the caller set laid over it. */
function commandEnvironment(env: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv | undefined {
  return env ? { ...process.env, ...env } : undefined;
}

/** The timeout the command gets: the caller's, or this platform's when the caller is silent. */
function timeoutFor(timeoutMs: number | undefined): number {
  return timeoutMs ?? DEFAULT_TIMEOUT_MS;
}

/** The command line as the runner wants it: every argument as text. */
function textArguments(args: readonly (string | number)[]): string[] {
  return args.map(String);
}

export function exec(command: string, args: readonly (string | number)[], options?: ExecOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    const settings: ExecFileOptionsWithStringEncoding = {
      timeout: timeoutFor(options?.timeoutMs),
      env: commandEnvironment(options?.env),
      encoding: STDOUT_ENCODING,
    };
    execFile(command, textArguments(args), settings, (error, stdout) => (error ? reject(error) : resolve(stdout)));
  });
}