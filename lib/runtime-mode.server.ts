import 'server-only'

export type OpenLinkRuntimeMode = 'local' | 'cloud'

const modes = new Set<OpenLinkRuntimeMode>(['local', 'cloud'])

export function getRuntimeMode(): OpenLinkRuntimeMode {
  // The local launcher is self-contained by default. Hosted deployments set
  // OPENLINK_RUNTIME_MODE=cloud explicitly in their service environment.
  const configured = (process.env.OPENLINK_RUNTIME_MODE ?? 'local').trim().toLowerCase()
  if (modes.has(configured as OpenLinkRuntimeMode)) return configured as OpenLinkRuntimeMode
  throw new Error('OPENLINK_RUNTIME_MODE must be either "local" or "cloud"')
}

export function isLocalRuntime() {
  return getRuntimeMode() === 'local'
}
