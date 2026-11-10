/**
 * The path flavour a request's environment uses.
 *
 * An agent can be running against a remote machine with a different path convention than the one it was started on, and
 * joining paths with the wrong flavour produces a path that does not exist there. The request context says which
 * operating system the work happens on, so path handling follows the target rather than the host.
 */
import path from "node:path";

/** The operating system name a request's environment reports, lower case, when it reports one. */
function reportedOsVersion(context: { env?: { osVersion?: string } }): string | undefined {
  return context.env?.osVersion?.toLowerCase();
}

/** Whether the work this request names happens on Windows. */
function runsOnWindows(context: { env?: { osVersion?: string } }): boolean {
  return reportedOsVersion(context)?.includes("win32") === true;
}

/** The path module that matches the request's operating system. */
export function getRequestPathModule(context: { env?: { osVersion?: string } }): typeof path.posix | typeof path.win32 {
  return runsOnWindows(context) ? path.win32 : path.posix;
}
