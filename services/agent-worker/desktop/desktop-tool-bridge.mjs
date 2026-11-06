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
  'wait', 'trace', 'status', 'permissions', 'version', 'batch', 'skills',
])
const blockedCommands = new Set(['session', 'cursor-overlay', 'key-down', 'key-up', 'mouse-down', 'mouse-up'])
const globalOptionsWithValues = new Set([
  '--session', '--agent-id', '--trace', '--screenshot', '--wait-for', '--wait-for-gone', '--wait-timeout', '-w',
])
let queue = Promise.resolve()

function json(res, status, value) {
  const body = `${JSON.stringify(value)}\n`
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

function commandPosition(argv) {
  for (let index = 0; index < argv.length;) {
    const argument = argv[index]
    if (globalOptionsWithValues.has(argument)) {
      index += 2
      continue
    }
    if (argument.startsWith('-')) {
      index += 1
      continue
    }
    return { command: argument, index }
  }
  return undefined
}

function bindSession(argv) {
  if (!activeSessionId) throw new Error('desktop session is not ready')
  const normalized = []
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--session') {
      const requested = argv[index + 1]
      if (!requested) throw new Error('--session requires a value')
      if (requested !== activeSessionId) throw new Error('desktop bridge requests must use the shared session')
      index += 1
      continue
    }
    if (argument.startsWith('--session=')) {
      if (argument.slice('--session='.length) !== activeSessionId) {
        throw new Error('desktop bridge requests must use the shared session')
      }
      continue
    }
    normalized.push(argument)
  }
  return ['--session', activeSessionId, ...normalized]
}

function validateBatch(argv, commandIndex) {
  const json = argv.slice(commandIndex + 1).find((argument) => argument.trimStart().startsWith('['))
  if (json === undefined) throw new Error('batch requires a JSON array')
  let entries
  try {
    entries = JSON.parse(json)
  } catch {
    throw new Error('batch JSON is invalid')
  }
  if (!Array.isArray(entries)) throw new Error('batch JSON must be an array')
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('batch entries must be objects')
    if (typeof entry.command !== 'string') throw new Error('batch entries must include a command')
    if (blockedCommands.has(entry.command) || entry.command === 'session') {
      throw new Error(`agent-desktop batch command is not allowed: ${entry.command}`)
    }
    if (entry.session !== undefined && entry.session !== activeSessionId) {
      throw new Error('desktop bridge batch entries must use the shared session')
    }
  }
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
  const argv = bindSession(value.argv)
  const position = commandPosition(argv)
  const command = position?.command
  if (!command || blockedCommands.has(command) || !allowedCommands.has(command)) {
    throw new Error(`agent-desktop command is not allowed: ${command}`)
  }
  if (command === 'batch') validateBatch(argv, position.index)
  return argv
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

let activeSessionId

async function startDesktopSession() {
  const started = await run(['session', 'start', '--no-trace', '--cursor'])
  let envelope
  try {
    envelope = JSON.parse(started.stdout)
  } catch {
    throw new Error(`Could not parse agent-desktop session startup output: ${started.stderr || started.stdout}`)
  }
  const sessionId = envelope?.data?.session_id
  if (typeof sessionId === 'string') {
    activeSessionId = sessionId
    process.env.AGENT_DESKTOP_SESSION = sessionId
  }
  if (started.exitCode !== 0 || envelope?.ok !== true || typeof sessionId !== 'string') {
    await endDesktopSession()
    throw new Error(`Could not start the agent-desktop session: ${started.stderr || started.stdout}`)
  }

  if (envelope.data.rendered === true) {
    process.stdout.write(`[openlink-desktop-tool] cursor overlay enabled for ${sessionId}\n`)
    return
  }

  const disabled = await run(['--session', sessionId, 'cursor-overlay', 'disable'])
  if (disabled.exitCode !== 0) {
    await endDesktopSession()
    throw new Error(`Could not disable unsupported cursor overlay: ${disabled.stderr || disabled.stdout}`)
  }
  process.stdout.write(`[openlink-desktop-tool] cursor overlay unavailable; session ${sessionId} will run without it\n`)
}

async function endDesktopSession() {
  if (!activeSessionId) return
  const ended = await run(['--session', activeSessionId, 'session', 'end'])
  if (ended.exitCode !== 0) {
    process.stderr.write(`[openlink-desktop-tool] session cleanup failed: ${ended.stderr || ended.stdout}\n`)
  }
  activeSessionId = undefined
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

try {
  await startDesktopSession()
} catch (error) {
  process.stderr.write(`[openlink-desktop-tool] cursor overlay startup failed: ${error instanceof Error ? error.message : String(error)}\n`)
  await endDesktopSession()
  process.exit(1)
}

server.listen(socketPath, async () => {
  await chmod(socketPath, 0o660)
  process.stdout.write(`[openlink-desktop-tool] listening on ${socketPath}\n`)
})
server.on('error', (error) => {
  process.stderr.write(`[openlink-desktop-tool] ${error.message}\n`)
  void endDesktopSession().finally(() => process.exit(1))
})

let shuttingDown = false
async function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  await new Promise((resolve) => server.close(resolve))
  await queue.catch(() => undefined)
  await endDesktopSession()
  process.exit(0)
}

process.on('SIGINT', () => { void shutdown() })
process.on('SIGTERM', () => { void shutdown() })
