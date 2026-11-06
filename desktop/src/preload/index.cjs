const { contextBridge, ipcRenderer } = require('electron')

/**
 * Narrow desktop bridge. The renderer never receives Node, filesystem, or
 * arbitrary Electron APIs; every operation is an explicit IPC channel.
 *
 * OpenLink Desktop is a client for Cloud and self-hosted instances. It does
 * not install or supervise a server runtime on the user's machine.
 */
const bridge = {
  version: 1,
  getState: () => ipcRenderer.invoke('desktop:state'),
  listProfiles: () => ipcRenderer.invoke('desktop:profiles:list'),
  upsertProfile: (profile) => ipcRenderer.invoke('desktop:profiles:upsert', profile),
  removeProfile: (id) => ipcRenderer.invoke('desktop:profiles:remove', id),
  activateProfile: (id) => ipcRenderer.invoke('desktop:profiles:activate', id),
  openExternal: (url) => ipcRenderer.invoke('desktop:open-external', url),
  auth: {
    hydite: (input) => ipcRenderer.invoke('desktop:auth:hydite', input),
  },
  onStateChanged(callback) {
    if (typeof callback !== 'function') return () => undefined
    const listener = (_event, state) => callback(state)
    ipcRenderer.on('desktop:state-changed', listener)
    return () => ipcRenderer.removeListener('desktop:state-changed', listener)
  },
  onOpenConnections(callback) {
    if (typeof callback !== 'function') return () => undefined
    const listener = () => callback()
    ipcRenderer.on('desktop:open-connections', listener)
    return () => ipcRenderer.removeListener('desktop:open-connections', listener)
  },
}

contextBridge.exposeInMainWorld('openLinkDesktop', Object.freeze(bridge))
