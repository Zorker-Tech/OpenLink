/** The box exec daemon's command line: run it, and report what stopped it. */
import { runBoxExecDaemonEntrypoint } from "./main.ts";

void runBoxExecDaemonEntrypoint().catch(error => {
  process.stderr.write(`box-exec-daemon: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
