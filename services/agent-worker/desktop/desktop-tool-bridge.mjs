#!/usr/bin/env node
// Project-VM-side bridge for agent-desktop.
//
// agent-desktop validates the owning process through /proc. A session
// container has its own PID namespace, so running the real binary there cannot
// see the project desktop's applications. Keep the privileged desktop access
// on the Project VM host and expose only a constrained Unix-socket command
// surface to the session container.

import { createServer } from 'node:http'
import { chmod, rm } from 'node:fs/promises'
import { spawn } from 'node:child_process'

const socketPath = process.env.OPENLINK_DESKTOP_TOOL_SOCKET || '/run/user/1000/openlink-desktop-tool.sock'
const binary = process.env.OPENLINK_AGENT_DESKTOP_BIN || '/usr/local/bin/agent-desktop'
const maxRequestBytes = 16 * 1024
const maxOutputBytes = 16 * 1024 * 1024
const commandTimeoutMs = 120_000
const allowedCommands = new Set([
  'snapshot', 'find', 'get', 'is', 'screenshot', 'list-surfaces',
  'click', 'double-click', 'triple-click', 'right-click', 'type', 'set-value', 'clear', 'focus', 'select', 'toggle', 'check', 'uncheck', 'expand', 'collapse', 'scroll', 'scroll-to',
  'press', 'hover', 'drag', 'mouse-move', 'mouse-click', 'mouse-wheel',
  'launch', 'close-app', 'list-apps', 'list-windows', 'list-displays', 'focus-window', 'resize-window', 'move-window', 'minimize', 'maximize', 'restore', 'open-system-surface',
  'list-notifications', 'dismiss-notification', 'dismiss-all-notifications', 'notification-action',
  'clipboard-get', 'clipboard-set', 'clipboard-clear',
  'wait', 'trace', 'cursor-overlay', 'status', 'permissions', 'version', 'batch', 'skills',
])
const blockedCommands = new Set(['session', 'key-down', 'key-up', 'mouse-down', 'mouse-up'])
let queue = Promise.resolve()

function json(res, status, value) {
  const body = `${JSON.stringify(value)}\n`
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

function validateRequest(value) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.argv)) throw new Error('argv must be an array')
  if (value.argv.length < 1 || value.argv.length > 64) throw new Error('argv length is invalid')
  let bytes = 0
  for (const argument of value.argv) {
    if (typeof argument !== 'string' || argument.includes('\0')) throw new Error('argv entries must be strings')
    bytes += Buffer.byteLength(argument)
  }
  if (bytes > maxRequestBytes) throw new Error('argv is too large')
  const command = value.argv[0]
  if (blockedCommands.has(command) || (!allowedCommands.has(command) && !command.startsWith('--'))) {
    throw new Error(`agent-desktop command is not allowed: ${command}`)
  }
  return value.argv
}

function run(argv) {
  return new Promise((resolve) => {
    const child = spawn(binary, argv, {
      cwd: process.env.HOME || '/home/openlink',
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const append = (current, chunk) => {
      if (current.length >= maxOutputBytes) return current
      const next = current + chunk.toString('utf8')
      return next.length > maxOutputBytes ? next.slice(0, maxOutputBytes) : next
    }
    child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk) })
    child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk) })
    child.on('error', (error) => finish({ exitCode: 1, stdout, stderr: `${stderr}${error.message}\n` }))
    child.on('close', (code, signal) => finish({ exitCode: code ?? (signal ? 1 : 0), stdout, stderr }))
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish({ exitCode: 124, stdout, stderr: `${stderr}agent-desktop timed out\n` })
    }, commandTimeoutMs)
    timer.unref()
  })
}

await rm(socketPath, { force: true })
const server = createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/run') {
    json(res, 404, { error: 'not found' })
    return
  }
  const chunks = []
  let bytes = 0
  req.on('data', (chunk) => {
    bytes += chunk.length
    if (bytes > maxRequestBytes) {
      req.destroy()
      return
    }
    chunks.push(chunk)
  })
  req.on('end', () => {
    let argv
    try {
      argv = validateRequest(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    } catch (error) {
      json(res, 400, { error: error instanceof Error ? error.message : String(error) })
      return
    }
    queue = queue.then(async () => {
      const result = await run(argv)
      json(res, 200, result)
    }).catch((error) => {
      json(res, 500, { error: error instanceof Error ? error.message : String(error) })
    })
  })
})

server.listen(socketPath, async () => {
  await chmod(socketPath, 0o660)
  process.stdout.write(`[openlink-desktop-tool] listening on ${socketPath}\n`)
})
server.on('error', (error) => {
  process.stderr.write(`[openlink-desktop-tool] ${error.message}\n`)
  process.exit(1)
})
