import { homedir } from 'node:os'
import { resolve } from 'node:path'

export function localRuntimeCacheRoot(env = process.env) {
  const configured = env.OPENLINK_LOCAL_RUNTIME_CACHE_ROOT?.trim()
  if (configured) return resolve(configured)
  const cacheHome = env.XDG_CACHE_HOME?.trim() || resolve(homedir(), '.cache')
  return resolve(cacheHome, 'openlink')
}
