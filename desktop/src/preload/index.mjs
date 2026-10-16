import { contextBridge } from 'electron'

const defaultAppUrl = 'http://127.0.0.1:3000'

contextBridge.exposeInMainWorld('openLinkDesktop', Object.freeze({
  appUrl: process.env.OPENLINK_DESKTOP_URL || defaultAppUrl,
}))
