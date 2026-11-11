/**
 * OpenLink bridge smoke check.
 *
 * Boots the built host against an isolated data root and exercises the exact
 * gateway commands the OpenLink BFF uses. This catches bundle/runtime drift
 * that a TypeScript-only check cannot see.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const hostEntry = join(packageRoot, 'dist', 'host.mjs')
const token = 'openlink-smoke-token'
const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2n1cAAAAASUVORK5CYII='

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function freePort() {
  const probe = createServer()
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const { port } = probe.address()
  await new Promise((resolve) => probe.close(resolve))
  return port
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function request(baseUrl, command, body) {
  const response = await fetch(`${baseUrl}/api/${command}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  const payload = await response.json().catch(() => null)
  assert(response.ok, `${command} failed with HTTP ${response.status}: ${JSON.stringify(payload)}`)
  return payload
}

async function waitForHealth(baseUrl, child) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`host exited before health check (${child.exitCode ?? child.signalCode})`)
    }
    try {
      const response = await fetch(`${baseUrl}/health`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (response.ok) {
        const payload = await response.json()
        assert(payload?.ok === true, 'host health response did not report ok')
        return payload
      }
    } catch {}
    await delay(100)
  }
  throw new Error('host did not become healthy within 30 seconds')
}

const port = await freePort()
const baseUrl = `http://127.0.0.1:${port}`
const dataRoot = mkdtempSync(join(tmpdir(), 'openlink-work-host-bridge-'))
const child = spawn(process.execPath, [hostEntry], {
  cwd: packageRoot,
  env: {
    ...process.env,
    SLATE_DATA_ROOT: dataRoot,
    SLATE_HOST_PORT: String(port),
    SLATE_GATEWAY_TOKEN: token,
    SLATE_GATEWAY_REQUIRE_AUTH: '1',
    SLATE_USE_EXISTING_BOX_EXEC_DAEMON: '1',
    SLATE_BACKEND_URL: 'http://127.0.0.1:1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let output = ''
let errors = ''
child.stdout.on('data', (chunk) => { output += String(chunk) })
child.stderr.on('data', (chunk) => { errors += String(chunk) })

try {
  await waitForHealth(baseUrl, child)
  const created = await request(baseUrl, 'createBackgroundAgent', {
    name: 'Bridge Smoke Bot',
    description: 'OpenLink bridge verification',
    avatarShape: 'blob',
    avatarColor: 'orange',
    origin: 'user',
    isIntroductionSuppressed: true,
  })
  const agentId = created?.agent?.id
  assert(typeof agentId === 'string' && agentId.length > 0, 'createBackgroundAgent did not return an agent id')

  const entries = [
    { id: 'smoke-user-1', kind: 'message', role: 'user', content: 'hello', timestampMs: Date.now() - 1_000 },
    { id: 'smoke-agent-1', kind: 'send-message', message: { type: 'text', content: 'hi' }, timestampMs: Date.now() },
  ]
  const appended = await request(baseUrl, 'appendAgentTranscriptEntries', { agentId, entries })
  assert(appended?.appended === 2, 'appendAgentTranscriptEntries did not append both entries')
  const transcript = await request(baseUrl, 'getAgentTranscript', { id: agentId })
  assert(Array.isArray(transcript) && transcript.length === 2, 'getAgentTranscript did not return the appended entries')

  const replacement = [
    { id: 'smoke-replacement-1', kind: 'send-message', message: { type: 'text', content: 'replacement' }, timestampMs: Date.now() },
  ]
  const replaced = await request(baseUrl, 'replaceAgentTranscriptEntries', { agentId, entries: replacement })
  assert(replaced?.replaced === 1, 'replaceAgentTranscriptEntries did not replace the transcript')
  const replacedTranscript = await request(baseUrl, 'getAgentTranscript', { id: agentId })
  assert(Array.isArray(replacedTranscript) && replacedTranscript.length === 1, 'replacement did not clear the stale transcript')
  assert(replacedTranscript[0]?.id === 'smoke-replacement-1', 'replacement did not persist the new entry')

  const appendedAgain = await request(baseUrl, 'appendAgentTranscriptEntries', {
    agentId,
    entries: [{ id: 'smoke-after-replace', kind: 'message', role: 'user', content: 'after replace', timestampMs: Date.now() }],
  })
  assert(appendedAgain?.appended === 1, 'append after replacement did not persist')
  const finalTranscript = await request(baseUrl, 'getAgentTranscript', { id: agentId })
  assert(Array.isArray(finalTranscript) && finalTranscript.length === 2, 'append after replacement returned the wrong length')

  await request(baseUrl, 'setAgentAvatarBytes', { id: agentId, pngBase64 })
  const avatarResponse = await fetch(`${baseUrl}/avatars/${encodeURIComponent(agentId)}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  assert(avatarResponse.ok, `avatar route returned HTTP ${avatarResponse.status}`)
  const avatarBytes = new Uint8Array(await avatarResponse.arrayBuffer())
  assert(avatarBytes.length === Buffer.from(pngBase64, 'base64').length, 'avatar route returned different bytes')

  await request(baseUrl, 'deleteAgent', { id: agentId })
  process.stdout.write('ok   OpenLink Bot bridge: health, agent, transcript append/replace and avatar round-trip\n')
} catch (error) {
  process.stderr.write(`FAIL OpenLink Bot bridge: ${error instanceof Error ? error.message : String(error)}\n`)
  if (output.trim()) process.stderr.write(`${output.trim()}\n`)
  if (errors.trim()) process.stderr.write(`${errors.trim()}\n`)
  process.exitCode = 1
} finally {
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    delay(10_000).then(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }),
  ])
  rmSync(dataRoot, { recursive: true, force: true })
}
