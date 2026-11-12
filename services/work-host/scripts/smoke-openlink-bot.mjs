/**
 * Bot control-plane smoke check.
 *
 * Boots the built host with a fake execution substrate and a fake Pi worker,
 * then drives a real Bot turn through the Work-host gateway. This verifies the
 * Bot binding, runner selection, Pi event translation, transcript persistence
 * and the Bot prompt stream together, without needing a Project VM.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { createServer as createPortProbe } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const hostEntry = join(packageRoot, 'dist', 'host.mjs')
const gatewayToken = 'openlink-bot-smoke-token'
const substrateToken = 'openlink-bot-smoke-substrate-token'
const projectId = '2c51ca26-3cd0-4cb4-896d-2061de06098c'
const botId = '11111111-1111-4111-8111-111111111111'
const assistantText = 'Hello from the Bot worker'

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function freePort() {
  const probe = createPortProbe()
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const { port } = probe.address()
  await new Promise((resolve) => probe.close(resolve))
  return port
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function readJson(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  const text = Buffer.concat(chunks).toString('utf8')
  return text ? JSON.parse(text) : {}
}

function json(response, status, value) {
  const body = JSON.stringify(value)
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
  response.end(body)
}

async function request(baseUrl, command, body, token = gatewayToken) {
  const response = await fetch(`${baseUrl}/api/${command}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
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
      const response = await fetch(`${baseUrl}/health`, { headers: { Authorization: `Bearer ${gatewayToken}` } })
      if (response.ok) {
        const payload = await response.json()
        assert(payload?.ok === true, 'host health response did not report ok')
        return
      }
    } catch {}
    await delay(100)
  }
  throw new Error('host did not become healthy within 30 seconds')
}

const substratePort = await freePort()
const substrateUrl = `http://127.0.0.1:${substratePort}`
const substrate = createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url ?? '/', substrateUrl)
    if (request.method === 'POST' && /^\/v1\/substrate\/bots\/[^/]+\/(?:ensure|desktop)$/.test(url.pathname)) {
      const body = await readJson(request)
      assert(typeof body.projectId === 'string', 'substrate ensure did not receive a projectId')
      assert(body.runtimeConfiguration?.providerId === 'deepseek', 'substrate ensure did not receive the runtime configuration')
      const boxKey = decodeURIComponent(url.pathname.split('/')[4] ?? '')
      return json(response, 200, {
        ok: true,
        boxKey,
        sandboxId: 'sandbox-smoke',
        workerUrl: substrateUrl,
        workerHeaders: { 'X-OpenLink-Agent-Worker-Token': 'worker-token' },
        desktopUrl: `${substrateUrl}/desktop/vnc.html`,
        vncUrl: `${substrateUrl}/desktop/vnc.html`,
      })
    }
    if (request.method === 'DELETE' && /^\/v1\/substrate\/bots\/[^/]+$/.test(url.pathname)) {
      return json(response, 200, { ok: true, released: true })
    }
    if (request.method === 'POST' && url.pathname === '/v1/events') {
      const body = await readJson(request)
      assert(typeof body.message === 'string' && body.message.length > 0, 'Pi worker received an empty prompt')
      response.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' })
      response.write(`${JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: assistantText } })}\n`)
      response.write(`${JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: assistantText }], usage: { input: 2, output: 5 } } })}\n`)
      response.write(`${JSON.stringify({ type: 'agent_settled' })}\n`)
      response.end()
      return
    }
    if (request.method === 'POST' && (url.pathname === '/v1/cancel' || url.pathname === '/v1/extension-ui-response')) {
      return json(response, 202, { ok: true })
    }
    return json(response, 404, { error: `unexpected substrate route ${request.method} ${url.pathname}` })
  })().catch((error) => {
    if (!response.headersSent) json(response, 500, { error: error instanceof Error ? error.message : String(error) })
    else response.end()
  })
})
await new Promise((resolve) => substrate.listen(substratePort, '127.0.0.1', resolve))

const port = await freePort()
const baseUrl = `http://127.0.0.1:${port}`
const dataRoot = mkdtempSync(join(tmpdir(), 'openlink-work-host-bot-'))
const child = spawn(process.execPath, [hostEntry], {
  cwd: packageRoot,
  env: {
    ...process.env,
    SLATE_DATA_ROOT: dataRoot,
    SLATE_HOST_PORT: String(port),
    SLATE_GATEWAY_TOKEN: gatewayToken,
    SLATE_GATEWAY_REQUIRE_AUTH: '1',
    SLATE_USE_EXISTING_BOX_EXEC_DAEMON: '1',
    SLATE_BACKEND_URL: 'http://127.0.0.1:1',
    OPENLINK_AGENT_HOST_URL: substrateUrl,
    OPENLINK_SUBSTRATE_API_TOKEN: substrateToken,
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
    name: 'Bot Smoke Agent',
    description: 'Bot control-plane verification',
    avatarShape: 'blob',
    avatarColor: 'orange',
    origin: 'user',
    isIntroductionSuppressed: true,
  })
  const agentId = created?.agent?.id
  assert(typeof agentId === 'string' && agentId.length > 0, 'createBackgroundAgent did not return an agent id')

  const box = await request(baseUrl, 'ensureBotBox', {
    agentId,
    botId,
    projectId,
    userId: 'smoke-user',
    workspaceId: 'smoke-workspace',
    runtimeConfiguration: {
      providerId: 'deepseek',
      modelId: 'deepseek-v4-flash',
      apiKey: 'smoke-key',
      baseUrl: 'https://api.deepseek.com',
      revision: 'smoke-revision',
    },
  })
  assert(box?.boxKey === `bot-${botId}`, 'ensureBotBox returned a different box key')
  assert(box?.desktopUrl === `${substrateUrl}/desktop/vnc.html`, 'ensureBotBox returned a different desktop URL')

  const stream = await fetch(`${baseUrl}/api/bot/sendPrompt`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${gatewayToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentId, prompt: 'hello Bot' }),
    signal: AbortSignal.timeout(30_000),
  })
  const streamText = await stream.text()
  assert(stream.ok, `Bot prompt stream failed with HTTP ${stream.status}: ${streamText.slice(0, 2000)}`)
  const frames = streamText.split('\n').filter(Boolean).map((line) => JSON.parse(line))
  assert(
    frames.some((frame) => frame.channel === 'transcript'
      && frame.payload?.entry?.kind === 'send-message'
      && frame.payload.entry.message?.content === assistantText),
    'the Bot stream did not deliver the assistant message',
  )
  assert(
    frames.some((frame) => frame.channel === 'bot-turn' && frame.payload?.phase === 'ended' && frame.payload?.ok === true),
    'the Bot stream did not end the turn',
  )

  // A group has no sandbox of its own: each member runs in its own Bot box.
  const second = await request(baseUrl, 'createBackgroundAgent', {
    name: 'Bot Smoke Agent Two',
    description: 'Second group member',
    avatarShape: 'blob',
    avatarColor: 'blue',
    origin: 'user',
    isIntroductionSuppressed: true,
  })
  const secondAgentId = second?.agent?.id
  assert(typeof secondAgentId === 'string' && secondAgentId.length > 0, 'the second group member was not created')
  await request(baseUrl, 'ensureBotBox', {
    agentId: secondAgentId,
    botId: '22222222-2222-4222-8222-222222222222',
    projectId,
    userId: 'smoke-user',
    workspaceId: 'smoke-workspace',
    runtimeConfiguration: {
      providerId: 'deepseek',
      modelId: 'deepseek-v4-flash',
      apiKey: 'smoke-key',
      baseUrl: 'https://api.deepseek.com',
      revision: 'smoke-revision',
    },
  })
  const group = await request(baseUrl, 'createGroup', {
    name: 'Smoke Group',
    description: 'Group control-plane verification',
    memberAgentIds: [agentId, secondAgentId],
    externalId: '33333333-3333-4333-8333-333333333333',
  })
  const groupAgentId = group?.agent?.id
  assert(typeof groupAgentId === 'string' && groupAgentId.length > 0, 'createGroup did not return a group agent')
  const groupStream = await fetch(`${baseUrl}/api/bot/sendPrompt`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${gatewayToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentId: groupAgentId, prompt: 'hello group' }),
    signal: AbortSignal.timeout(30_000),
  })
  const groupStreamText = await groupStream.text()
  assert(groupStream.ok, `group prompt stream failed with HTTP ${groupStream.status}: ${groupStreamText.slice(0, 2000)}`)
  const groupFrames = groupStreamText.split('\n').filter(Boolean).map((line) => JSON.parse(line))
  assert(
    groupFrames.some((frame) => frame.channel === 'transcript'
      && frame.payload?.type === 'group-turn'
      && frame.payload?.phase === 'ended'),
    'the group stream did not end the group turn',
  )
  assert(
    groupFrames.some((frame) => frame.channel === 'transcript'
      && frame.payload?.entry?.kind === 'send-message'
      && frame.payload.entry.message?.content === assistantText),
    'the group stream did not deliver a member message',
  )

  const status = await request(baseUrl, 'getBotBoxStatus', { agentId })
  assert(status?.state === 'running', 'getBotBoxStatus did not report a running box')
  const released = await request(baseUrl, 'releaseBotBox', { agentId })
  assert(released?.released === true, 'releaseBotBox did not release the binding')
  const afterRelease = await request(baseUrl, 'getBotBoxStatus', { agentId })
  assert(afterRelease?.state === 'absent', 'getBotBoxStatus still reports a released box')

  process.stdout.write('ok   OpenLink Bot control plane: binding, Pi turn, group turn, transcript stream and release\n')
} catch (error) {
  process.stderr.write(`FAIL OpenLink Bot control plane: ${error instanceof Error ? error.message : String(error)}\n`)
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
  await new Promise((resolve) => substrate.close(resolve))
  rmSync(dataRoot, { recursive: true, force: true })
}
