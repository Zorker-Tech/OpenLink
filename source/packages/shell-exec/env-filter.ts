/**
 * The environment a shell is given, with the parts that must not travel removed.
 *
 * Two kinds of variable are taken out. One is the flag that turns an Electron binary into a plain node:
 * leaving it set would change what the child process is, and a shell is not a node process. The others are
 * the addresses of sockets that belong to the user's desktop session — an authentication agent, a bus, a
 * display — because a command run on the user's behalf should not inherit the ability to talk to their
 * session's services.
 */

export const SOCKET_ENV_VARS_TO_SCRUB = ["SSH_AUTH_SOCK", "DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR", "WAYLAND_DISPLAY"] as const

export function filterElectronEnv(env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { ELECTRON_RUN_AS_NODE: _discarded, ...filteredEnv } = env || process.env
  return filteredEnv
}

export function scrubSocketEnvVars(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result = { ...env }
  for (const key of SOCKET_ENV_VARS_TO_SCRUB) delete result[key]
  return result
}
