import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const root = fileURLToPath(new URL('../', import.meta.url))
const require = createRequire(import.meta.url)
const electronBinary = require('electron')
const server = await createServer({ configFile: resolve(root, 'vite.config.mjs') })
await server.listen()

const rendererUrl = server.resolvedUrls?.local?.[0]
if (!rendererUrl) {
  await server.close()
  throw new Error('Electron renderer dev server did not expose a local URL')
}

const electron = spawn(electronBinary, ['.'], {
  cwd: root,
  env: { ...process.env, OPENLINK_DESKTOP_RENDERER_URL: rendererUrl },
  stdio: 'inherit',
})

let shuttingDown = false
async function shutdown(signal) {
  if (shuttingDown) return
  shuttingDown = true
  if (electron.exitCode === null && electron.signalCode === null) electron.kill(signal)
  await server.close()
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => { void shutdown(signal) })
}
electron.once('error', (error) => {
  process.stderr.write(`Unable to start Electron: ${error.message}\n`)
  void shutdown('SIGTERM').finally(() => { process.exitCode = 1 })
})
electron.once('exit', (code) => {
  void server.close().finally(() => { process.exitCode = code ?? 0 })
})
