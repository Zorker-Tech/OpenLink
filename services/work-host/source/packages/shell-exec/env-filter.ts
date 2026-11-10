/**
 * The environment a shell is given, with the parts that must not travel removed.
 *
 * Two kinds of variable are taken out. One is the flag that turns an Electron binary into a plain node:
 * leaving it set would change what the child process is, and a shell is not a node process. The others are
 * the addresses of sockets that belong to the user's desktop session — an authentication agent, a bus, a
 * display — because a command run on the user's behalf should not inherit the ability to talk to their
 * session's services.
 */

/** The session variables a command must not inherit: they name the user's desktop sockets. */
export const SOCKET_ENV_VARS_TO_SCRUB = ["SSH_AUTH_SOCK", "DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR", "WAYLAND_DISPLAY"] as const

/** The variable that makes an Electron binary behave as a plain node: a shell child must not see it. */
const ELECTRON_RUN_AS_NODE_VARIABLE = "ELECTRON_RUN_AS_NODE"

/** The environment a child starts with: the one given, or the process's own. */
function inheritedEnvironment(env: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  return env || process.env
}

export function filterElectronEnv(env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const filtered = { ...inheritedEnvironment(env) }
  delete filtered[ELECTRON_RUN_AS_NODE_VARIABLE]
  return filtered
}

export function scrubSocketEnvVars(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const scrubbed = { ...env }
  for (const variableName of SOCKET_ENV_VARS_TO_SCRUB) delete scrubbed[variableName]
  return scrubbed
}
