import { runBoxExecDaemonEntrypoint } from "./main.ts";

/** Process effects used by the command line's startup boundary. */
export interface BoxExecCliRuntime {
  writeStderr(line: string): void
  setExitCode(code: number): void
}

const processRuntime: BoxExecCliRuntime = {
  writeStderr: line => { process.stderr.write(line) },
  setExitCode: code => { process.exitCode = code },
}

/** Starts the daemon and turns a failed startup into one diagnostic and a non-zero process status. */
export async function runBoxExecCli(
  start: () => Promise<void> = runBoxExecDaemonEntrypoint,
  runtime: BoxExecCliRuntime = processRuntime,
): Promise<void> {
  try {
    await start()
  } catch (error) {
    const detail = error instanceof Error ? error.stack ?? error.message : String(error)
    runtime.writeStderr(`box-exec-daemon: ${detail}\n`)
    runtime.setExitCode(1)
  }
}

if (import.meta.filename === process.argv[1]) void runBoxExecCli()
