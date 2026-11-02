#!/usr/bin/env node
// Session-container CLI shim. The real agent-desktop binary runs on the
// Project VM host behind a constrained Unix socket because the container
// cannot inspect the desktop's host PID namespace.

import { request } from 'node:http'

const socketPath = process.env.OPENLINK_DESKTOP_TOOL_SOCKET || '/run/user/1000/openlink-desktop-tool.sock'
const argv = process.argv.slice(2)
if (!argv.length) {
  process.stderr.write('agent-desktop: a command is required\n')
  process.exit(2)
}
const payload = Buffer.from(JSON.stringify({ argv }))
const req = request({
  socketPath,
  path: '/run',
  method: 'POST',
  headers: { 'content-type': 'application/json', 'content-length': payload.length },
  timeout: 125_000,
}, (res) => {
  const chunks = []
  res.on('data', (chunk) => chunks.push(chunk))
  res.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8')
    let value
    try { value = JSON.parse(body) } catch {
      process.stderr.write(`agent-desktop bridge returned an invalid response (HTTP ${res.statusCode})\n`)
      process.exit(1)
    }
    if (res.statusCode !== 200 || value?.error) {
      process.stderr.write(`agent-desktop bridge: ${value?.error || `HTTP ${res.statusCode}`}\n`)
      process.exit(1)
    }
    if (value.stdout) process.stdout.write(value.stdout)
    if (value.stderr) process.stderr.write(value.stderr)
    process.exit(Number.isInteger(value.exitCode) ? value.exitCode : 1)
  })
})
req.on('timeout', () => {
  req.destroy(new Error('agent-desktop bridge timed out'))
})
req.on('error', (error) => {
  process.stderr.write(`agent-desktop bridge is unavailable: ${error.message}\n`)
  process.exit(1)
})
req.end(payload)
