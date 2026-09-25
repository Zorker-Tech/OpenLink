/**
 * The path flavour a request's environment uses.
 *
 * An agent can be running against a remote machine with a different path convention than the one it
 * was started on, and joining paths with the wrong flavour produces a path that does not exist there.
 * The request context says which operating system the work happens on, so path handling follows the
 * target rather than the host.
 */

import path from "node:path"

export function getRequestPathModule(
  requestContext: { env?: { osVersion?: string } },
): typeof path.posix | typeof path.win32 {
  return requestContext.env?.osVersion?.toLowerCase().includes("win32") === true ? path.win32 : path.posix
}
