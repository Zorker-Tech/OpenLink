import { app, BrowserWindow, ipcMain, Menu, session, shell } from 'electron'
import { join, resolve } from 'node:path'

import { startGatewayWithFallback } from './gateway.mjs'
import { createDesktopAuth } from './auth.mjs'
import {
  createProfileStore,
  DEFAULT_GATEWAY_PORT,
} from './profiles.mjs'

const devRendererUrl = process.env.OPENLINK_DESKTOP_RENDERER_URL || null
const rendererDir = join(app.getAppPath(), 'dist-renderer')
const preloadPath = join(app.getAppPath(), 'src/preload/index.cjs')

// A first-run window has no active server yet. The gateway still needs a
// loopback origin to serve the renderer, so point it at a closed discard port
// and let the setup surface add and activate a real Cloud/self-hosted profile.
const SETUP_PROFILE = Object.freeze({ id: 'setup', kind: 'remote' })
const SETUP_UPSTREAM = 'http://127.0.0.1:9'

// Test and portable installations can isolate the profile store, cookies, and
// caches without touching the user's normal desktop data directory.
if (process.env.OPENLINK_DESKTOP_USER_DATA) {
  app.setPath('userData', resolve(process.env.OPENLINK_DESKTOP_USER_DATA))
}

let mainWindow = null
let gateway = null
let store = null
let activeProfile = null
let desktopAuth = null
let quitting = false
// Destroying the old window during a profile switch briefly leaves zero
// windows. Without this guard `window-all-closed` quits the app before the new
// gateway/window exists.
let relaunching = false

function openExternal(value) {
  try {
    const url = new URL(String(value))
    if (url.protocol === 'https:' || url.protocol === 'http:') {
      void shell.openExternal(url.href)
      return true
    }
  } catch {
    // Ignore malformed navigation requests.
  }
  return false
}

function sendOpenConnections() {
  const target = BrowserWindow.getFocusedWindow() ?? mainWindow
  target?.webContents.send('desktop:open-connections')
}

function installApplicationMenu() {
  const template = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'Connections…',
          accelerator: 'CmdOrCtrl+,',
          click: () => sendOpenConnections(),
        },
        { type: 'separator' },
        { role: process.platform === 'darwin' ? 'close' : 'quit' },
      ],
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function defaultProfile() {
  if (process.env.OPENLINK_DESKTOP_URL) {
    return {
      id: 'remote-default',
      kind: 'remote',
      name: process.env.OPENLINK_DESKTOP_PROFILE_NAME || 'Remote',
      upstreamUrl: process.env.OPENLINK_DESKTOP_URL,
      gatewayPort: DEFAULT_GATEWAY_PORT,
    }
  }
  if (process.env.OPENLINK_DESKTOP_CLOUD_URL) {
    return {
      id: 'cloud-default',
      kind: 'cloud',
      name: 'Cloud',
      upstreamUrl: process.env.OPENLINK_DESKTOP_CLOUD_URL,
      gatewayPort: DEFAULT_GATEWAY_PORT,
    }
  }
  // No bundled runtime: a first run starts in the setup surface and the user
  // adds a Cloud or self-hosted server.
  return null
}

async function startForProfile(profile) {
  if (devRendererUrl) {
    return { origin: devRendererUrl, upstream: null, dev: true, setup: !profile }
  }

  const upstreamUrl = profile?.upstreamUrl || SETUP_UPSTREAM
  gateway = await startGatewayWithFallback({
    rendererDir,
    upstreamUrl,
    profile: profile ?? SETUP_PROFILE,
    port: profile?.gatewayPort || DEFAULT_GATEWAY_PORT,
  })

  if (profile && profile.gatewayPort !== gateway.port) {
    activeProfile = await store.upsert({ ...profile, gatewayPort: gateway.port })
  }
  return {
    origin: gateway.origin,
    upstream: profile ? gateway.upstream : null,
    dev: false,
    setup: !profile,
  }
}

function createWindow(origin, profile) {
  const effectiveProfile = profile ?? SETUP_PROFILE
  const partition = `persist:openlink:${effectiveProfile.id}`
  const browserSession = session.fromPartition(partition)
  const allowedOrigin = new URL(origin).origin

  browserSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    // Clipboard access is required by the composer; everything else stays
    // denied unless a feature explicitly adds a narrow grant.
    callback(permission === 'clipboard-read' || permission === 'clipboard-sanitized-write')
  })

  const window = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 760,
    minHeight: 560,
    show: false,
    backgroundColor: '#0b0b0c',
    title: 'OpenLink',
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      partition,
      spellcheck: true,
    },
  })

  window.once('ready-to-show', () => window.show())
  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, target) => {
    try {
      if (new URL(target).origin === allowedOrigin) return
    } catch {
      // Reject non-HTTP targets.
    }
    event.preventDefault()
    openExternal(target)
  })
  window.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    if (isMainFrame && code !== -3) {
      console.error(`[desktop] failed to load ${url}: ${description} (${code})`)
    }
  })
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null
  })

  void window.loadURL(origin)
  mainWindow = window
  return window
}

function stateSnapshot() {
  const active = store?.active() ?? null
  return {
    profiles: store?.list() ?? [],
    activeProfileId: active?.id ?? null,
    gateway: gateway
      ? { origin: gateway.origin, upstream: gateway.upstream, setup: !active }
      : devRendererUrl
        ? { origin: devRendererUrl, dev: true, setup: !active }
        : null,
    platform: process.platform,
    versions: {
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
    },
  }
}

function broadcastState() {
  const state = stateSnapshot()
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('desktop:state-changed', state)
  }
}

async function relaunch(profile) {
  relaunching = true
  try {
    if (mainWindow) {
      mainWindow.destroy()
      mainWindow = null
    }
    if (gateway) {
      await gateway.close().catch(() => undefined)
      gateway = null
    }
    activeProfile = profile ?? null
    const target = await startForProfile(activeProfile)
    createWindow(target.origin, activeProfile)
  } finally {
    relaunching = false
  }
  broadcastState()
  return stateSnapshot()
}

function registerIpc() {
  ipcMain.handle('desktop:state', () => stateSnapshot())

  ipcMain.handle('desktop:profiles:list', () => store.list())

  ipcMain.handle('desktop:profiles:upsert', async (_event, input) => {
    const profile = await store.upsert(input)
    broadcastState()
    return profile
  })

  ipcMain.handle('desktop:profiles:remove', async (_event, id) => {
    const removedId = String(id)
    const wasActive = store.active()?.id === removedId
    const removed = await store.remove(removedId)
    if (wasActive) {
      // Removing the active profile returns to the setup surface when no
      // other server remains.
      await relaunch(store.active())
    } else {
      broadcastState()
    }
    return removed
  })

  ipcMain.handle('desktop:profiles:activate', async (_event, id) => {
    const profile = store.get(String(id))
    if (!profile) throw new Error('Desktop profile was not found')
    await store.setActive(profile.id)
    return relaunch(profile)
  })

  ipcMain.handle('desktop:open-external', (_event, url) => openExternal(url))

  ipcMain.handle('desktop:auth:hydite', (_event, input) => desktopAuth.hydite(input))
}

const hasLock = app.requestSingleInstanceLock()
if (!hasLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  app.whenReady().then(async () => {
    desktopAuth = createDesktopAuth({
      openExternal: (url) => shell.openExternal(url),
    })
    store = createProfileStore({
      filePath: join(app.getPath('userData'), 'profiles.json'),
      defaultProfile: defaultProfile(),
    })
    await store.load()
    activeProfile = store.active()

    registerIpc()
    installApplicationMenu()
    try {
      const target = await startForProfile(activeProfile)
      createWindow(target.origin, activeProfile)
    } catch (error) {
      console.error('[desktop] startup failed', error)
      const message = encodeURIComponent(
        error instanceof Error ? error.message : 'Desktop startup failed',
      )
      createWindow(
        `data:text/html;charset=utf-8,${encodeURIComponent(
          `<html><body style="font-family:system-ui;padding:40px"><h1>OpenLink could not start</h1><pre>${decodeURIComponent(message)}</pre></body></html>`,
        )}`,
        activeProfile,
      )
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0 && gateway) {
        createWindow(gateway.origin, activeProfile)
      }
    })
  })

  app.on('window-all-closed', () => {
    if (relaunching) return
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', (event) => {
    desktopAuth?.cancel?.()
    if (quitting || !gateway) return
    event.preventDefault()
    quitting = true
    void gateway
      .close()
      .catch(() => undefined)
      .finally(() => {
        gateway = null
        app.quit()
      })
  })
}
