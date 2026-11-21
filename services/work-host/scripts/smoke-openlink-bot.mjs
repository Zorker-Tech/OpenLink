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
const proactiveText = 'The fixture has a documented rollback check, but no matching test.'
const firstReplyText = 'Hi! What would you like to work on?'
const genericReplyPrompt = 'Reply without a useful quick result'
const slowQuickReplyPrompt = 'Wait for the full result if the fast reply is late'
const completeFirstReplyPrompt = 'How many minutes are in an hour?'
const completeFirstReplyText = 'An hour has 60 minutes.'
const privateGroupDraft = 'This draft must never reach the public group.'
const fullTurnPrompts = []
let observationAt = 0
let proactiveManagementResolved = false
let releaseBurst
const burstGate = new Promise(resolve => { releaseBurst = resolve })
let burstStarted = 0
const burstPrompt = 'Keep working on the queued messages'

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
    signal: AbortSignal.timeout(30_000),
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
    if (request.method === 'POST' && url.pathname === '/api/bots/internal/manage') {
      const body = await readJson(request)
      assert(request.headers.authorization === `Bearer ${gatewayToken}`, 'The management callback was not authenticated')
      assert(body.botId === botId && body.userId === 'smoke-user' && body.workspaceId === 'smoke-workspace', 'The management callback did not use the Bot binding scope')
      assert(body.action === 'create_routine' && body.schedule === '0 9 * * 1-5', 'The proactive routine request was not forwarded')
      return json(response, 201, { routine: { id: 'rollback-review', isEnabled: false } })
    }
    if (request.method === 'POST' && url.pathname === '/v1/management/resolve') {
      const body = await readJson(request)
      assert(body.id === 'proactive-tool-call' && body.result?.routine?.id === 'rollback-review', 'The tool did not receive its correlated result')
      proactiveManagementResolved = true
      response.writeHead(204).end()
      return
    }
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
    if (request.method === 'POST' && url.pathname === '/v1/inspiration/observations') {
      return json(response, 200, {
        cursor: `aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:${observationAt ? 1 : 0}`,
        observations: observationAt ? [{ sequence: 1, observedAt: observationAt, files: ['tests/rollback.test.ts'] }] : [],
      })
    }
    if (request.method === 'POST' && url.pathname === '/v1/inspiration/context') {
      return json(response, 200, { topLevel: ['tests'], recentFiles: ['tests/rollback.test.ts'] })
    }
    if (request.method === 'POST' && url.pathname === '/v1/inspiration/complete') {
      const { systemPrompt, prompt, maxTokens, temperature, latencySensitive } = await readJson(request)
      if (systemPrompt.startsWith('Write the first conversational sentence')) {
        const dialogue = JSON.parse(prompt)
        assert(temperature === 0.85 && maxTokens === 192, 'The first-response completion did not use its own sampling options')
        assert(systemPrompt.includes('in the user’s language') && latencySensitive, 'The first-reply request did not select the latency-sensitive path')
        const finished = dialogue.latestUserMessage === completeFirstReplyPrompt
        if (dialogue.latestUserMessage === burstPrompt) {
          await delay(200)
          return json(response, 200, { text: JSON.stringify({ m: 'I’ll check each queued request', f: true, e: null }) })
        }
        if (dialogue.latestUserMessage === slowQuickReplyPrompt) {
          await delay(4_500)
          return json(response, 200, { text: JSON.stringify({ m: 'This arrived too late.', f: true, e: null }) })
        }
        const firstReply = { message: finished ? completeFirstReplyText : firstReplyText, emoji: finished ? null : '👋', needsFollowUp: !finished }
        return json(response, 200, { text: dialogue.latestUserMessage === genericReplyPrompt ? '收到你的消息。' : JSON.stringify(firstReply) })
      }
      const result = systemPrompt.startsWith('You score') ? { score: 0.98, reason: 'New release check' }
        : systemPrompt.includes('candidate gate') ? { selection: 0, mode: 'investigate', reason: 'Read-only verification is useful' }
        : { candidates: [{ title: 'Inspect rollback validation', whyNow: 'The test file changed', firstAction: 'Read the test file', expectedValue: 0.9, lens: 'tests' }] }
      return json(response, 200, { text: JSON.stringify(result), costUsd: 0, usage: { totalTokens: 20 } })
    }
    if (request.method === 'POST' && url.pathname === '/v1/group/events') {
      const body = await readJson(request)
      assert(body.deliveryGuidance?.includes('participant in a group chat'), 'The isolated worker did not receive the group system prompt')
      response.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' })
      for (const event of [
        { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: privateGroupDraft } },
        { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: privateGroupDraft } },
        { type: 'send-message', message: { content: '{"message":null}' } },
        { type: 'send-message', message: { content: assistantText } },
        { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: privateGroupDraft }] } },
        { type: 'agent_settled' },
      ]) response.write(`${JSON.stringify(event)}\n`)
      response.end()
      return
    }
    if (request.method === 'POST' && url.pathname === '/v1/events') {
      const body = await readJson(request)
      assert(typeof body.message === 'string' && body.message.length > 0, 'Pi worker received an empty prompt')
      fullTurnPrompts.push(body.message)
      response.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' })
      if (body.message.includes(burstPrompt)) {
        burstStarted += 1
        await burstGate
      }
      if (body.message.startsWith('This is the first Bot in the workspace.')) {
        response.write(`${JSON.stringify({ type: 'send-message', message: { content: 'Want me to set up a specialist teammate or start a group?' } })}\n`)
      }
      if (body.message === 'hello Bot') {
        assert(body.deliveryGuidance?.includes('SendMessage'), 'Work-host did not supply Bot delivery guidance')
        assert(body.deliveryGuidance?.includes(firstReplyText), 'The continuation did not receive the delivered first reply')
        await delay(5_100)
        response.write(`${JSON.stringify({ type: 'send-message', message: { content: firstReplyText } })}\n`)
        response.write(`${JSON.stringify({ type: 'send-message', message: { content: 'I verified the first checkpoint.' } })}\n`)
      }
      if (body.message === genericReplyPrompt) await delay(150)
      if (body.message.startsWith('[inspiration]')) {
        assert(body.management === true, 'Proactive turns do not have the management tool')
        response.write(`${JSON.stringify({ type: 'openlink_bot_management', id: 'proactive-tool-call', parameters: {
          action: 'create_routine', name: 'Rollback review', schedule: '0 9 * * 1-5', prompt: 'Review the current rollback checks.', isEnabled: false,
        } })}\n`)
      }
      const finalText = body.message.startsWith('[inspiration]') ? JSON.stringify({ message: proactiveText })
        : body.message === 'hello Bot' ? JSON.stringify({ message: assistantText }) : assistantText
      response.write(`${JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: finalText } })}\n`)
      response.write(`${JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: finalText }], usage: { input: 2, output: 5 } } })}\n`)
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
    OPENLINK_WORK_HOST_APP_ORIGIN: substrateUrl,
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
    isIntroductionSuppressed: false,
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

  const introduction = await request(baseUrl, 'kickstartAgent', { id: agentId })
  assert(introduction.isIntroductionInFlight, 'A newly provisioned Bot did not start its welcome')
  const welcomeDeadline = Date.now() + 10_000
  let welcomed = false
  while (Date.now() < welcomeDeadline) {
    const entries = await request(baseUrl, 'getAgentTranscript', { id: agentId })
    if (entries.some(entry => entry.kind === 'send-message' && entry.message?.content === 'Want me to set up a specialist teammate or start a group?')) {
      welcomed = true
      break
    }
    await delay(100)
  }
  assert(welcomed, 'The welcome model response was not persisted')
  const nextIntroduction = await request(baseUrl, 'kickstartAgent', { id: agentId })
  assert(!nextIntroduction.isIntroductionInFlight, 'A completed welcome ran again')

  const stream = await fetch(`${baseUrl}/api/bot/sendPrompt`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${gatewayToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentId, prompt: 'hello Bot' }),
    signal: AbortSignal.timeout(30_000),
  })
  const streamText = await stream.text()
  assert(stream.ok, `Bot prompt stream failed with HTTP ${stream.status}: ${streamText.slice(0, 2000)}`)
  const frames = streamText.split('\n').filter(Boolean).map((line) => JSON.parse(line))
  const transcript = frames.filter(frame => frame.channel === 'transcript').map(frame => frame.payload?.entry).filter(Boolean)
  const accepted = transcript.find(entry => entry.kind === 'message' && entry.role === 'user' && entry.content === 'hello Bot')
  const receipt = transcript.find(entry => entry.hostReceipt === true)
  assert(accepted && receipt, 'Work-host did not publish a receipt during the slow Worker turn')
  assert(receipt.message?.content === firstReplyText, 'The first reply did not come from the model completion')
  assert(receipt.timestampMs - accepted.timestampMs <= 4_000, 'The receipt missed the four-second deadline')
  assert(transcript.some(entry => entry.id === accepted.id && entry.reactions?.some(({ emoji, by }) => emoji === '👋' && by === agentId)), 'The first reply reaction did not attach to the user’s message')
  assert(transcript.filter(entry => entry.message?.content === firstReplyText).length === 1, 'The continuation duplicated the first reply')
  const partialIndex = transcript.findIndex(entry => entry.message?.content === 'I verified the first checkpoint.')
  const finalIndex = transcript.findIndex(entry => entry.message?.content === assistantText)
  assert(partialIndex > transcript.indexOf(receipt) && finalIndex > partialIndex, 'Receipt, progress and final text must be delivered in order')
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

  const genericStream = await fetch(`${baseUrl}/api/bot/sendPrompt`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${gatewayToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentId, prompt: genericReplyPrompt }),
    signal: AbortSignal.timeout(30_000),
  })
  const genericFrames = (await genericStream.text()).split('\n').filter(Boolean).map(line => JSON.parse(line))
  const genericEntries = genericFrames.filter(frame => frame.channel === 'transcript').map(frame => frame.payload?.entry).filter(Boolean)
  assert(genericStream.ok && genericEntries.some(entry => entry.message?.content === assistantText), 'The full turn did not answer after an invalid quick reply')
  assert(!genericEntries.some(entry => entry.hostReceipt === true || entry.message?.content === '收到你的消息。'), 'Generic text escaped into the transcript')

  const completeStream = await fetch(`${baseUrl}/api/bot/sendPrompt`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${gatewayToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentId, prompt: completeFirstReplyPrompt }),
    signal: AbortSignal.timeout(30_000),
  })
  const completeFrames = (await completeStream.text()).split('\n').filter(Boolean).map(line => JSON.parse(line))
  const completeMessages = completeFrames.filter(frame => frame.channel === 'transcript' && frame.payload?.entry?.kind === 'send-message')
  assert(completeStream.ok && completeMessages.length === 1 && completeMessages[0].payload.entry.message.content === completeFirstReplyText, 'A complete first reply did not finish the turn on its own')
  assert(!fullTurnPrompts.includes(completeFirstReplyPrompt), 'The model declined a follow-up, but the host ran one')
  assert(!completeFrames.some(frame => frame.channel === 'tray' && frame.payload?.tray?.kind === 'error'), 'The host reported a failure for a completed first reply')

  const slowQuickStream = await fetch(`${baseUrl}/api/bot/sendPrompt`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${gatewayToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentId, prompt: slowQuickReplyPrompt }),
    signal: AbortSignal.timeout(30_000),
  })
  const slowQuickEntries = (await slowQuickStream.text()).split('\n').filter(Boolean)
    .map(line => JSON.parse(line).payload?.entry).filter(Boolean)
  assert(!slowQuickEntries.some(entry => entry.hostReceipt), 'A first reply arrived after its deadline')
  assert(slowQuickEntries.some(entry => entry.message?.content === assistantText), 'The full reply did not continue after the deadline')

  try {
    const send = (clientNonce, replyToId) => request(baseUrl, 'sendPrompt', {
      agentId, prompt: burstPrompt, acceptOnly: true, requireQuickBotReply: true, clientNonce, replyToId,
    });
    const first = await send('burst-first-send');
    const startedBy = Date.now() + 5_000;
    while (burstStarted === 0 && Date.now() < startedBy) await delay(30);
    assert(burstStarted === 1, 'The first queued turn did not reach the held worker');
    const second = await send('burst-second-send', first.entryId);
    const third = await send('burst-third-send');
    assert(new Set([first.entryId, second.entryId, third.entryId]).size === 3, 'Identical sends did not get separate durable IDs');
    const replay = await send('burst-second-send', first.entryId);
    assert(replay.entryId === second.entryId && burstStarted === 1, 'Acceptance waited for a reply or replay started another turn');
    const stored = await request(baseUrl, 'getAgentTranscript', { id: agentId });
    const acceptedEntries = stored.filter(entry => entry.content === burstPrompt);
    assert(acceptedEntries.map(entry => entry.id).join(',') === [first.entryId, second.entryId, third.entryId].join(','), 'Queued messages were missing or out of order');
    assert(acceptedEntries[1].replyTo === first.entryId, 'The queued reply did not keep its target');
    const quickDeadline = Date.now() + 3_500;
    let quickReplies;
    while (Date.now() < quickDeadline) {
      const entries = await request(baseUrl, 'getAgentTranscript', { id: agentId });
      quickReplies = entries.filter(entry => entry.hostReceipt && acceptedEntries.some(sent => sent.id === entry.firstBotReplyTo));
      if (quickReplies.length === 3) break;
      await delay(50);
    }
    assert(quickReplies?.length === 3, 'A new send cancelled another message’s first reply');
    assert(quickReplies.every(reply => reply.timestampMs - acceptedEntries.find(sent => sent.id === reply.firstBotReplyTo).timestampMs <= 4_000), 'A queued first reply missed its budget');
  } finally {
    releaseBurst();
  }
  const burstDeadline = Date.now() + 8_000;
  while (burstStarted < 3 && Date.now() < burstDeadline) await delay(30);
  assert(burstStarted === 3, 'One or more accepted user messages never reached the model');

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
  assert(!groupStreamText.includes(privateGroupDraft), 'Private text reached the group stream')
  const groupFrames = groupStreamText.split('\n').filter(Boolean).map((line) => JSON.parse(line))
  assert(
    groupFrames.every((frame) => {
      const entry = frame.payload?.entry
      const content = entry?.message?.content ?? entry?.content
      return typeof content !== 'string' || !/^\s*\{\s*"message"\s*:\s*null\s*\}\s*$/.test(content)
    }),
    'An internal control marker reached the group stream',
  )
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
  assert(groupFrames.some(frame => frame.channel === 'transcript' && frame.payload?.type === 'group-member' && frame.payload?.member?.id), 'The group stream did not expose member activity')

  const status = await request(baseUrl, 'getBotBoxStatus', { agentId })
  assert(status?.state === 'running', 'getBotBoxStatus did not report a running box')
  await request(baseUrl, 'releaseBotBox', { agentId: secondAgentId })
  observationAt = Date.now() - 6_000
  const deadline = Date.now() + 45_000
  let reviewed
  while (Date.now() < deadline) {
    const state = await request(baseUrl, 'getInspirationState', { id: agentId })
    reviewed = state?.ledger?.find(entry => entry.trigger === 'event')
    if (reviewed) break
    await delay(500)
  }
  assert(reviewed?.outcome === 'acted' && reviewed.messageCount === 1, 'An observed file did not trigger a delivered background result')
  assert(proactiveManagementResolved, 'The background turn could not create a routine through its management tool')
  const persisted = await request(baseUrl, 'getAgentTranscript', { id: agentId })
  assert(persisted.some(entry => entry.kind === 'send-message' && entry.message?.content === proactiveText), 'The proactive result was not saved to the conversation')
  const released = await request(baseUrl, 'releaseBotBox', { agentId })
  assert(released?.released === true, 'releaseBotBox did not release the binding')
  const afterRelease = await request(baseUrl, 'getBotBoxStatus', { agentId })
  assert(afterRelease?.state === 'absent', 'getBotBoxStatus still reports a released box')
  assert(!errors.includes('[slate][turn] agent run failed'), 'The host failed while settling a Bot turn')

  process.stdout.write('ok   OpenLink Bot control plane: direct, group and proactive message delivery\n')
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
