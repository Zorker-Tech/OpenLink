import { spawn } from 'node:child_process'
import { packageManagerCommand } from './lib/host-platform.mjs'

const separator = process.argv.indexOf('--', 2)
if (separator < 0 || separator === process.argv.length - 1) {
  throw new Error('Usage: node scripts/run-with-env.mjs KEY=VALUE [...] -- command [args...]')
}

const env = { ...process.env }
for (const assignment of process.argv.slice(2, separator)) {
  const index = assignment.indexOf('=')
  if (index <= 0) throw new Error(`Invalid environment assignment: ${assignment}`)
  const key = assignment.slice(0, index)
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`Invalid environment variable name: ${key}`)
  env[key] = assignment.slice(index + 1)
}

const [requestedCommand, ...args] = process.argv.slice(separator + 1)
const command = requestedCommand === 'node'
  ? process.execPath
  : packageManagerCommand(requestedCommand)
const child = spawn(command, args, { env, shell: false, stdio: 'inherit', windowsHide: true })
child.once('error', (error) => { throw error })
child.once('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exit(code ?? 1)
})
