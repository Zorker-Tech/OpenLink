#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

function argumentsMap(argv) {
  const values = new Map()
  for (let index = 0; index < argv.length; index += 2) {
    if (!argv[index]?.startsWith('--') || argv[index + 1] === undefined) throw new Error(`Invalid argument near ${argv[index] ?? '<end>'}`)
    values.set(argv[index].slice(2), argv[index + 1])
  }
  return values
}

function upstream(port, name) {
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json')
    response.end(`${JSON.stringify({ upstream: name, path: request.url })}\n`)
  })
  return new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(port, '127.0.0.1', () => resolveListen(server))
  })
}

async function probe(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  let failure
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) })
      if (response.ok) return { response, body: await response.text() }
      failure = new Error(`HTTP ${response.status}`)
    } catch (error) { failure = error }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
  }
  throw failure ?? new Error(`Timed out probing ${url}`)
}

export async function qualifyEdge(options) {
  const releaseRoot = resolve(options.releaseRoot)
  const address = options.address ?? 'http://127.0.0.1:17443'
  const servers = await Promise.all([upstream(3000, 'web'), upstream(43121, 'gateway'), upstream(8000, 'zokerbase')])
  const child = spawn(join(releaseRoot, 'edge/bin/caddy'), ['run', '--config', join(releaseRoot, 'edge/Caddyfile'), '--adapter', 'caddyfile'], {
    cwd: releaseRoot,
    env: { ...process.env, OPENLINK_EDGE_ADDRESS: address },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr.on('data', (chunk) => { stderr += String(chunk) })
  try {
    const expectations = [
      ['/', 'web'],
      ['/v1/browser/gateway/session', 'gateway'],
      ['/auth/v1/token', 'zokerbase'],
      ['/rest/v1/items', 'zokerbase'],
      ['/storage/v1/object', 'zokerbase'],
      ['/realtime/v1/websocket', 'zokerbase'],
    ]
    const routes = []
    for (const [path, expected] of expectations) {
      const { response, body } = await probe(`${address}${path}`)
      const parsed = JSON.parse(body)
      if (parsed.upstream !== expected || parsed.path !== path) throw new Error(`Route ${path} reached ${parsed.upstream}:${parsed.path}`)
      if (response.headers.get('x-content-type-options') !== 'nosniff') throw new Error(`Security headers are missing on ${path}`)
      routes.push({ path, upstream: parsed.upstream, status: response.status })
    }
    return { ok: true, address, routes }
  } finally {
    child.kill('SIGTERM')
    await Promise.race([
      new Promise((resolveExit) => child.once('exit', resolveExit)),
      new Promise((resolveDelay) => setTimeout(resolveDelay, 5_000)),
    ])
    if (child.exitCode === null) child.kill('SIGKILL')
    await Promise.all(servers.map((server) => new Promise((resolveClose) => server.close(resolveClose))))
    if (child.exitCode && child.exitCode !== 0 && !stderr.includes('shutting down')) throw new Error(`Caddy qualification failed: ${stderr.slice(-2000)}`)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const values = argumentsMap(process.argv.slice(2))
  qualifyEdge({ releaseRoot: values.get('release-root'), address: values.get('address') })
    .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch((error) => { process.stderr.write(`edge qualification failed: ${error.message}\n`); process.exitCode = 1 })
}
