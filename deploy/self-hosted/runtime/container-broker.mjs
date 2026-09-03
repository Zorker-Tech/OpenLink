import { createConnection, createServer } from 'node:net'
import { chmod, lstat, mkdir, rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

const ACTIONS = new Set(['status', 'start', 'stop'])

export function requestContainerBroker(socketPath, action, options = {}) {
  if (!ACTIONS.has(action)) return Promise.reject(new Error(`Container broker action is not allowed: ${action}`))
  const socket = resolve(socketPath)
  return new Promise((resolveRequest, rejectRequest) => {
    const client = createConnection(socket)
    const timeout = setTimeout(() => client.destroy(new Error('Container broker request timed out')), options.timeoutMs ?? 660_000)
    let response = ''
    let settled = false
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      callback(value)
    }
    client.setEncoding('utf8')
    client.once('connect', () => client.end(`${JSON.stringify({ schemaVersion: 1, action })}\n`))
    client.on('data', (chunk) => {
      response += chunk
      if (response.length > 64 * 1024) client.destroy(new Error('Container broker response is too large'))
    })
    client.once('error', (error) => finish(rejectRequest, error))
    client.once('end', () => {
      try {
        const result = JSON.parse(response)
        if (result?.ok !== true) throw new Error(result?.error || 'Container broker rejected the request')
        finish(resolveRequest, result)
      } catch (error) {
        finish(rejectRequest, error)
      }
    })
  })
}

export async function serveContainerBroker(socketPath, handler) {
  const socket = resolve(socketPath)
  await mkdir(dirname(socket), { recursive: true, mode: 0o750 })
  const existing = await lstat(socket).catch((error) => error?.code === 'ENOENT' ? undefined : Promise.reject(error))
  if (existing && !existing.isSocket()) throw new Error(`Container broker refuses to replace a non-socket path: ${socket}`)
  await rm(socket, { force: true })
  let queue = Promise.resolve()
  let pending = 0
  const maximumPending = 16
  const server = createServer({ allowHalfOpen: true }, (connection) => {
    connection.setEncoding('utf8')
    connection.setTimeout(5_000, () => connection.destroy(new Error('Container broker request timed out')))
    let request = ''
    let oversized = false
    connection.once('error', () => undefined)
    connection.on('data', (chunk) => {
      if (oversized) return
      request += chunk
      if (request.length > 4096) {
        oversized = true
        connection.destroy(new Error('Container broker request is too large'))
      }
    })
    connection.once('end', () => {
      if (oversized || connection.destroyed) return
      if (pending >= maximumPending) {
        connection.end(`${JSON.stringify({ ok: false, error: 'Container broker is busy' })}\n`)
        return
      }
      pending += 1
      queue = queue.then(async () => {
        const frames = request.split('\n').filter(Boolean)
        if (!request.endsWith('\n') || frames.length !== 1) throw new Error('Container broker accepts exactly one newline-terminated request')
        const message = JSON.parse(frames[0])
        if (message?.schemaVersion !== 1 || !ACTIONS.has(message?.action) || Object.keys(message).some((key) => !['schemaVersion', 'action'].includes(key))) {
          throw new Error('Container broker request is invalid')
        }
        const result = await handler(message.action)
        if (!connection.destroyed) connection.end(`${JSON.stringify({ ok: true, action: message.action, result })}\n`)
      }).catch((error) => {
        if (!connection.destroyed) connection.end(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`)
      }).finally(() => {
        pending -= 1
      })
    })
  })
  server.maxConnections = 64
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(socket, resolveListen)
  })
  await chmod(socket, 0o660)
  return {
    socket,
    server,
    async close() {
      await new Promise((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose()))
      await rm(socket, { force: true })
    },
  }
}
