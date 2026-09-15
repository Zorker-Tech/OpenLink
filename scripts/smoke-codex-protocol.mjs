import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
const child = spawn('codex', ['app-server'], { stdio: ['pipe', 'pipe', 'ignore'] })
const pending = new Map()
let nextId = 0
const lines = createInterface({ input: child.stdout })
lines.on('line', line => {
  const data = JSON.parse(line)
  const waiter = pending.get(data.id)
  if (!waiter) return
  pending.delete(data.id)
  data.error ? waiter.reject(new Error(data.error.message)) : waiter.resolve(data.result)
})
const timer = setTimeout(() => { child.kill(); process.exitCode = 1 }, 15000)
function request(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++nextId
    pending.set(id, { resolve, reject })
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n')
  })
}
try {
  await request('initialize', { clientInfo: { name: 'openlink_protocol_smoke', version: '1' }, capabilities: { experimentalApi: true } })
  child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n')
  const result = await request('collaborationMode/list', {})
  console.log(JSON.stringify({ result }))
} finally { clearTimeout(timer); lines.close(); child.kill() }
