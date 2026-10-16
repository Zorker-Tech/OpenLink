import { app, BrowserWindow, shell } from 'electron'
import { join } from 'node:path'

const defaultAppUrl = 'http://127.0.0.1:3000'
const appUrl = resolveApplicationUrl(process.env.OPENLINK_DESKTOP_URL || defaultAppUrl)

function resolveApplicationUrl(value) {
  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error('OPENLINK_DESKTOP_URL must be a valid HTTP or HTTPS URL')
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('OPENLINK_DESKTOP_URL must be a credential-free HTTP or HTTPS URL')
  }
  return url
}

function openExternal(value) {
  try {
    const url = new URL(value)
    if (url.protocol === 'https:' || url.protocol === 'http:') void shell.openExternal(url.href)
  } catch {
    // Ignore malformed navigation requests.
  }
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1400,
    height: 920,
    minWidth: 720,
    minHeight: 560,
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: join(app.getAppPath(), 'src/preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, target) => {
    try {
      if (new URL(target).origin === appUrl.origin) return
    } catch {
      // Reject non-HTTP navigation targets.
    }
    event.preventDefault()
    openExternal(target)
  })

  const rendererUrl = process.env.OPENLINK_DESKTOP_RENDERER_URL
  return rendererUrl
    ? window.loadURL(rendererUrl)
    : window.loadFile(join(app.getAppPath(), 'out/renderer/index.html'))
}

app.whenReady().then(createWindow)
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) void createWindow()
})
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
