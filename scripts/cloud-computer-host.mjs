import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { MemoryOAuthTokenStore } from '@vtslx/platform-sdk/auth'
import { PlatformProductSdk } from '@vtslx/platform-sdk/product'
import { CloudOmpAgent } from './cloud-omp-agent.mjs'

const host = '127.0.0.1'
const port = Number(process.env.OPENLINK_CLOUD_HOST_PORT || 43126)
const apiToken = process.env.OPENLINK_CLOUD_HOST_API_TOKEN?.trim() || ''
const clientId = process.env.OPENLINK_CLOUD_OAUTH_CLIENT_ID?.trim() || ''
const appUrl = process.env.OPENLINK_APP_URL?.trim() || ''
const checkpointDirectory = process.env.OPENLINK_CLOUD_AGENT_CHECKPOINT_DIR?.trim() || ''
const encodedCheckpointKey = process.env.OPENLINK_CLOUD_AGENT_CHECKPOINT_KEY?.trim() || ''
const checkpointKey = Buffer.from(encodedCheckpointKey, 'base64')
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const chatSessionId = /^[A-Za-z0-9]{11}$/
const maxBodyBytes = 16 * 1024 * 1024
const maxFileBytes = 2 * 1024 * 1024
const activeAgents = new Map()

if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
  throw new Error('OPENLINK_CLOUD_HOST_PORT must be between 1 and 65535')
}
if (!apiToken || apiToken.length < 32) {
  throw new Error('OPENLINK_CLOUD_HOST_API_TOKEN must contain at least 32 characters')
}
if (!checkpointDirectory || checkpointKey.byteLength !== 32) {
  throw new Error('Encrypted Cloud Computer checkpoint storage is not configured')
}

await mkdir(checkpointDirectory, { recursive: true, mode: 0o700 })

function json(response, status, value) {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff',
  })
  response.end(JSON.stringify(value))
}

function hasInternalAuthorization(request) {
  const header = request.headers.authorization
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false
  const supplied = Buffer.from(header.slice(7))
  const expected = Buffer.from(apiToken)
  return supplied.length === expected.length && timingSafeEqual(supplied, expected)
}

async function readJson(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > maxBodyBytes) throw new Error('body-too-large')
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new Error('invalid-json')
  }
}

function checkpointBinding(input) {
  return `${input.openlinkUserId}|${input.openlinkProjectId}|${input.projectRef}|${input.sessionId}`
}

function runtimeConfigurationIdentity(runtimeConfiguration) {
  return createHash('sha256').update(JSON.stringify(runtimeConfiguration)).digest('hex')
}

function computerAgentDirectory(input) {
  const binding = checkpointBinding(input)
  return `/workspace/.openlink/agent-config/${createHash('sha256').update(binding).digest('hex')}`
}

function validRuntimeConfiguration(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  return typeof value.providerId === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(value.providerId)
    && typeof value.modelId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(value.modelId)
    && typeof value.apiKey === 'string' && value.apiKey.length <= 64 * 1024
    && typeof value.baseUrl === 'string' && value.baseUrl.length <= 2048
    && typeof value.revision === 'string' && value.revision.length <= 256
    && typeof value.api === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(value.api)
    && typeof value.name === 'string' && value.name.length > 0 && value.name.length <= 160
    && typeof value.reasoning === 'boolean'
    && Array.isArray(value.input) && value.input.length > 0 && value.input.length <= 8
    && value.input.every((item) => typeof item === 'string' && item.length > 0 && item.length <= 32)
    && Number.isSafeInteger(value.contextWindow) && value.contextWindow > 0 && value.contextWindow <= 10_000_000
    && Number.isSafeInteger(value.maxTokens) && value.maxTokens > 0 && value.maxTokens <= 10_000_000
    && value.cost && typeof value.cost === 'object' && !Array.isArray(value.cost)
    && Number.isFinite(value.cost.input) && Number.isFinite(value.cost.output)
    && (value.cost.cacheRead === undefined || Number.isFinite(value.cost.cacheRead))
    && (value.cost.cacheWrite === undefined || Number.isFinite(value.cost.cacheWrite))
    && value.baseUrl.length > 0
}

async function runComputerCommand(computer, argv) {
  const result = await computer.realtime.execStream({
    argv,
    cwd: '/workspace',
    timeoutMs: 30_000,
    idempotencyKey: `openlink-config-${randomUUID()}`,
  }, () => {})
  if (result.status !== 'completed' || result.exitCode !== 0) throw new Error('computer-agent-config-sync-failed')
}

async function syncAgentConfiguration(computer, input) {
  const runtime = input.runtimeConfiguration
  const directory = computerAgentDirectory(input)
  await computer.realtime.makeDirectory(directory, {
    recursive: true,
    idempotencyKey: `openlink-config-directory-${randomUUID()}`,
  })
  await runComputerCommand(computer, ['chmod', '700', directory])

  const model = {
    id: runtime.modelId,
    name: runtime.name,
    reasoning: runtime.reasoning,
    input: runtime.input,
    contextWindow: runtime.contextWindow,
    maxTokens: runtime.maxTokens,
    cost: runtime.cost,
  }
  const models = {
    providers: {
      [runtime.providerId]: {
        baseUrl: runtime.baseUrl,
        api: runtime.api,
        // Pi validates custom models against a provider API-key setting in
        // models.json. Keep the app-managed key here as well as in auth.json;
        // both files live in this session-only, mode-0600 config directory.
        ...(runtime.apiKey ? { apiKey: runtime.apiKey } : {}),
        models: [model],
      },
    },
  }
  const auth = runtime.apiKey
    ? { [runtime.providerId]: { type: 'api_key', key: runtime.apiKey } }
    : {}
  await computer.realtime.writeFile(`${directory}/models.json`, JSON.stringify(models), {
    idempotencyKey: `openlink-model-config-${randomUUID()}`,
  })
  await computer.realtime.writeFile(`${directory}/auth.json`, JSON.stringify(auth), {
    idempotencyKey: `openlink-auth-config-${randomUUID()}`,
  })
  await runComputerCommand(computer, ['chmod', '600', `${directory}/models.json`, `${directory}/auth.json`])
  return directory
}

function checkpointPath(input) {
  const id = createHash('sha256').update(checkpointBinding(input)).digest('hex')
  return resolve(checkpointDirectory, `${id}.checkpoint`)
}

async function saveCheckpoint(input, checkpoint) {
  const plaintext = Buffer.from(JSON.stringify(checkpoint))
  if (plaintext.byteLength > 1024 * 1024) throw new Error('checkpoint-too-large')
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', checkpointKey, iv)
  cipher.setAAD(Buffer.from(checkpointBinding(input)))
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const envelope = JSON.stringify({ version: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') })
  const target = checkpointPath(input)
  const temporary = `${target}.${randomUUID()}.tmp`
  await writeFile(temporary, envelope, { mode: 0o600, flag: 'wx' })
  await rename(temporary, target)
}

async function loadCheckpoint(input) {
  const target = checkpointPath(input)
  let source
  try {
    source = await readFile(target)
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
  if (source.byteLength > 2 * 1024 * 1024) throw new Error('checkpoint-too-large')
  const envelope = JSON.parse(source.toString('utf8'))
  if (envelope.version !== 1 || typeof envelope.iv !== 'string' || typeof envelope.tag !== 'string' || typeof envelope.ciphertext !== 'string') {
    throw new Error('checkpoint-invalid')
  }
  const decipher = createDecipheriv('aes-256-gcm', checkpointKey, Buffer.from(envelope.iv, 'base64'))
  decipher.setAAD(Buffer.from(checkpointBinding(input)))
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'))
  const plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()])
  const checkpoint = JSON.parse(plaintext.toString('utf8'))
  if (checkpoint.version !== 1 || checkpoint.agentSessionId !== input.sessionId
    || (checkpoint.agentKind ?? 'pi') !== (input.agent ?? 'pi')
    || checkpoint.runtimeIdentity !== runtimeConfigurationIdentity(input.runtimeConfiguration)
    || checkpoint.computer?.projectRef !== input.projectRef
    || checkpoint.terminal?.state !== 'running') throw new Error('checkpoint-invalid')
  return checkpoint
}

async function clearCheckpoint(input) {
  const target = checkpointPath(input)
  try {
    await unlink(target)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

function validAuthorization(value, requireWrite = false) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  return uuid.test(value.projectRef ?? '')
    && uuid.test(value.openlinkUserId ?? '')
    && uuid.test(value.openlinkProjectId ?? '')
    && typeof value.expectedSubject === 'string'
    && value.expectedSubject.length > 0
    && value.expectedSubject.length <= 255
    && typeof value.accessToken === 'string'
    && value.accessToken.length > 0
    && value.accessToken.length <= 16_384
    && !/[\s\u0000-\u001f\u007f]/.test(value.accessToken)
    && Array.isArray(value.scope)
    && value.scope.length <= 64
    && value.scope.every((scope) => typeof scope === 'string' && scope.length <= 128 && !/\s/.test(scope))
    && value.scope.includes('computer:read')
    && (!requireWrite || value.scope.includes('computer:write'))
    && Number.isSafeInteger(value.expiresAt)
    && value.expiresAt > Date.now() + 30_000
}

function cloudSdk(input) {
  if (!clientId || !appUrl) throw new Error('cloud-sdk-not-configured')
  let origin
  try {
    const url = new URL(appUrl)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error()
    origin = url.origin
  } catch {
    throw new Error('cloud-sdk-not-configured')
  }

  const tokenStore = new MemoryOAuthTokenStore()
  return tokenStore.save({
    accessToken: input.accessToken,
    tokenType: 'Bearer',
    scope: input.scope,
    expiresAt: input.expiresAt,
  }).then(() => {
    const insecureOrigins = process.env.OPENLINK_CLOUD_INSECURE_HTTP_ORIGIN?.trim() === origin && origin.startsWith('http://')
      ? [origin]
      : []
    return new PlatformProductSdk({
      auth: {
        issuer: 'https://auth.hydite.com',
        clientId,
        redirectUri: `${origin}/auth/platform/callback`,
        scopes: ['openid', 'profile', 'email', 'computer:read', 'computer:write'],
        tokenStore,
        allowInsecureHttpRedirectOrigins: insecureOrigins,
      },
      apiBaseUrls: ['https://auth.hydite.com'],
      computerServiceZones: configuredComputerServiceZones().zones,
    })
  })
}

function configuredComputerServiceZones() {
  const configured = process.env.OPENLINK_CLOUD_COMPUTER_SERVICE_ZONES?.trim()
  if (!configured) return { zones: [], error: 'COMPUTER_SERVICE_ZONE_NOT_CONFIGURED' }
  const zones = configured.split(',').map((value) => value.trim().replace(/^\.+|\.+$/g, '').toLowerCase())
  if (zones.length > 16 || zones.some((zone) => {
    const labels = zone.split('.')
    return zone.length > 253 || labels.length < 2 || labels.some((label) => label.length > 63
      || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))
      || zone === 'workers.dev' || zone.endsWith('.workers.dev')
  })) return { zones: [], error: 'COMPUTER_SERVICE_ZONE_INVALID' }
  return { zones: [...new Set(zones)], error: null }
}

function validComputerServiceId(value) {
  if (value === 'code-server') return true
  if (typeof value !== 'string' || !/^web-\d{1,5}$/.test(value)) return false
  const port = Number(value.slice(4))
  return Number.isSafeInteger(port) && port > 0 && port <= 65_535 && port !== 8443 && port !== 8444
}

function publicComputerService(value) {
  if (!value || typeof value !== 'object' || !validComputerServiceId(value.id)
    || typeof value.name !== 'string' || value.name.length < 1 || value.name.length > 64
    || !Number.isSafeInteger(value.port) || value.port < 1 || value.port > 65_535
    || value.protocol !== 'http' || !['running', 'stopped', 'unavailable'].includes(value.status)
    || typeof value.supportsWebSocket !== 'boolean') return null
  if ((value.id === 'code-server' && value.port !== 8443)
    || (value.id !== 'code-server' && value.id !== `web-${value.port}`)) return null
  return {
    id: value.id,
    name: value.name,
    port: value.port,
    protocol: 'http',
    status: value.status,
    supportsWebSocket: value.supportsWebSocket,
    ...(Number.isSafeInteger(value.httpStatus) && value.httpStatus >= 100 && value.httpStatus <= 599
      ? { httpStatus: value.httpStatus }
      : {}),
  }
}

async function verifyIdentity(sdk, input) {
  return sdk.auth.userInfo({ expectedSubject: input.expectedSubject })
}

function validAgentContext(input, requireMessage = false) {
  if (!validAuthorization(input, true)
    || !uuid.test(input.workspaceId ?? '')
    || !chatSessionId.test(input.sessionId ?? '')
    || !validRuntimeConfiguration(input.runtimeConfiguration)) return false
  if (requireMessage && (typeof input.message !== 'string' || !input.message.trim() || input.message.length > 10_000)) return false
  if (!input.model || typeof input.model !== 'object' || Array.isArray(input.model)
    || input.model.providerId !== input.runtimeConfiguration.providerId
    || input.model.modelId !== input.runtimeConfiguration.modelId) return false
  if (input.agent !== undefined && input.agent !== 'pi' && input.agent !== 'omp') return false
  return input.attachments === undefined || (Array.isArray(input.attachments) && input.attachments.length <= 24)
}

function sdkErrorCode(error) {
  const message = error instanceof Error ? error.message : ''
  if (/terminal capability|files capability|exec capability|capability.*(?:denied|not granted|required)/i.test(message)) {
    return 'COMPUTER_AGENT_CAPABILITY_REQUIRED'
  }
  if (/scope|forbidden|unauthorized|access denied|not authorized/i.test(message)) {
    return 'CLOUD_CONNECTION_INACTIVE'
  }
  return 'COMPUTER_AGENT_UNAVAILABLE'
}

function safeExtension(mediaType) {
  const extensions = {
    'application/pdf': 'pdf',
    'application/zip': 'zip',
    'application/json': 'json',
    'text/plain': 'txt',
    'text/markdown': 'md',
    'text/csv': 'csv',
    'image/gif': 'gif',
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
  }
  return extensions[mediaType] || 'bin'
}

function validBase64(value) {
  return typeof value === 'string'
    && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
}

async function uploadSmallAttachment(agent, input, bytes, index, mediaType) {
  if (bytes.byteLength > 32 * 1024) throw new Error('CLOUD_ATTACHMENT_TOO_LARGE')
  const directory = `/workspace/.openlink/attachments/${input.sessionId}`
  const path = `${directory}/attachment-${index + 1}.${safeExtension(mediaType)}`
  await agent.computer.realtime.makeDirectory(directory, {
    recursive: true,
    idempotencyKey: `openlink-mkdir-${randomUUID()}`,
  })
  await agent.computer.realtime.writeFile(path, new Uint8Array(bytes), {
    idempotencyKey: `openlink-write-${randomUUID()}`,
  })
  return path
}

async function promptWithAttachments(agent, input) {
  const attachments = input.attachments || []
  const additions = []
  let textBytes = 0
  let fileBytes = 0
  for (let index = 0; index < attachments.length; index += 1) {
    const item = attachments[index]
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('INVALID_ATTACHMENTS')
    if (item.type === 'text' || item.type === 'instruction') {
      const text = typeof item.text === 'string' ? item.text : ''
      textBytes += Buffer.byteLength(text, 'utf8')
      if (!text || text.length > 256 * 1024 || textBytes > 512 * 1024) throw new Error('INVALID_ATTACHMENTS')
      const name = typeof item.filename === 'string' ? item.filename : typeof item.name === 'string' ? item.name : 'attachment'
      additions.push(`<attachment name="${name.slice(0, 160)}">\n${text}\n</attachment>`)
      continue
    }
    if (item.type === 'reference') {
      const name = typeof item.name === 'string' ? item.name.slice(0, 160) : 'reference'
      const path = typeof item.path === 'string' ? item.path.slice(0, 1024) : ''
      if (!path) throw new Error('INVALID_ATTACHMENTS')
      additions.push(`Reference ${name}: ${path}`)
      continue
    }

    let mediaType
    let encoded
    if (item.type === 'file') {
      mediaType = typeof item.mediaType === 'string' ? item.mediaType.toLowerCase() : ''
      encoded = item.contentBase64
      if (!uuid.test(item.uploadId ?? '') || !uuid.test(item.batchId ?? '')
        || !Number.isSafeInteger(item.sizeBytes) || item.sizeBytes < 0 || item.sizeBytes > maxFileBytes
        || typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(item.sha256)
        || !validBase64(encoded)) throw new Error('INVALID_ATTACHMENTS')
    } else if (item.type === 'image') {
      mediaType = typeof item.mediaType === 'string' ? item.mediaType.toLowerCase() : ''
      if (!/^image\/(?:png|jpeg|webp|gif)$/.test(mediaType)
        || typeof item.url !== 'string' || !item.url.startsWith(`data:${mediaType};base64,`)) throw new Error('INVALID_ATTACHMENTS')
      encoded = item.url.slice(`data:${mediaType};base64,`.length)
      if (!validBase64(encoded) || encoded.length > 3_000_000) throw new Error('INVALID_ATTACHMENTS')
    } else {
      throw new Error('INVALID_ATTACHMENTS')
    }

    const bytes = Buffer.from(encoded, 'base64')
    fileBytes += encoded.length
    if (fileBytes > 12_000_000 || bytes.byteLength > maxFileBytes
      || (item.type === 'file' && (bytes.byteLength !== item.sizeBytes
        || createHash('sha256').update(bytes).digest('hex') !== item.sha256.toLowerCase()))) {
      throw new Error('INVALID_ATTACHMENTS')
    }
    const path = await uploadSmallAttachment(agent, input, bytes, index, mediaType)
    const name = item.type === 'file' && typeof item.filename === 'string' ? item.filename.slice(0, 160) : `image-${index + 1}`
    additions.push(`Attached ${name} is available at ${path}`)
  }
  return additions.length ? `${input.message}\n\n${additions.join('\n\n')}` : input.message
}

async function createCloudAgent(input) {
  const agentKind = input.agent === 'omp' ? 'omp' : 'pi'
  const runtimeIdentity = runtimeConfigurationIdentity(input.runtimeConfiguration)
  const sdk = await cloudSdk(input)
  await verifyIdentity(sdk, input)
  const capabilities = ['terminal', 'files', 'exec']
  let checkpoint = null
  try {
    checkpoint = await loadCheckpoint(input)
    if (checkpoint?.hostCapabilities && capabilities.some((capability) => !checkpoint.hostCapabilities.includes(capability))) {
      checkpoint = null
      await clearCheckpoint(input)
    }
  } catch {
    checkpoint = null
    await clearCheckpoint(input).catch(() => undefined)
  }

  let computer
  let agent
  const persistCheckpoint = async (terminal) => saveCheckpoint(input, {
    version: 1,
    agentKind,
    runtimeIdentity,
    computer: computer.exportCheckpoint(),
    agentSessionId: input.sessionId,
    terminal,
    hostCapabilities: computer.session.capabilities,
  })
  if (checkpoint) {
    try {
      computer = await sdk.resumeComputerStream(input.projectRef, checkpoint.computer, {
        requestTimeoutMs: 180_000,
      })
      if (!capabilities.every((capability) => computer.session.capabilities.includes(capability))) {
        await computer.close().catch(() => undefined)
        computer = undefined
        checkpoint = null
      } else {
        agent = agentKind === 'omp'
          ? await CloudOmpAgent.open(computer, {
            sessionId: input.sessionId,
            sessionDir: `/workspace/.openlink/omp-sessions/${input.sessionId}`,
            agentDir: computerAgentDirectory(input),
            terminalCheckpoint: checkpoint.terminal,
            persistCheckpoint: async (agentCheckpoint) => saveCheckpoint(input, {
              ...agentCheckpoint,
              runtimeIdentity,
              hostCapabilities: computer.session.capabilities,
            }),
            heartbeatIntervalMs: 30_000,
          })
          : await computer.resumePiAgent(checkpoint, {
            persistCheckpoint,
            heartbeatIntervalMs: 30_000,
          })
      }
    } catch {
      await computer?.close().catch(() => undefined)
      computer = undefined
      agent = undefined
      checkpoint = null
      await clearCheckpoint(input).catch(() => undefined)
    }
  }
  if (!agent) {
    computer = await sdk.openComputerStream(input.projectRef, {
      capabilities,
      idempotencyKey: `openlink-session-${randomUUID()}`,
      requestTimeoutMs: 180_000,
    })
    try {
      const agentDir = await syncAgentConfiguration(computer, input)
      agent = agentKind === 'omp'
        ? await CloudOmpAgent.open(computer, {
          sessionId: input.sessionId,
          sessionDir: `/workspace/.openlink/omp-sessions/${input.sessionId}`,
          agentDir,
          persistCheckpoint: async (agentCheckpoint) => saveCheckpoint(input, {
            ...agentCheckpoint,
            runtimeIdentity,
            hostCapabilities: computer.session.capabilities,
          }),
          heartbeatIntervalMs: 30_000,
        })
        : await computer.openPiAgent({
          terminalIdempotencyKey: `openlink-terminal-${randomUUID()}`,
          agentSessionId: input.sessionId,
          agentDir,
          cwd: '/workspace',
          heartbeatIntervalMs: 30_000,
          persistCheckpoint,
        })
    } catch (error) {
      await computer.close().catch(() => undefined)
      throw error
    }
  }
  try {
    await saveCheckpoint(input, {
      ...agent.exportCheckpoint(),
      agentKind,
      runtimeIdentity,
      hostCapabilities: computer.session.capabilities,
    })
  } catch (error) {
    await agent.close().catch(() => undefined)
    throw error
  }
  return { sdk, computer, agent, agentKind, capabilities }
}

function scheduleAgentCleanup(key, active) {
  if (active.idleTimer) clearTimeout(active.idleTimer)
  active.idleTimer = setTimeout(() => {
    if (active.busy || activeAgents.get(key) !== active) return
    activeAgents.delete(key)
    void active.agent.close().catch(() => undefined).finally(() => clearCheckpoint(active.input).catch(() => undefined))
  }, 15 * 60_000)
  active.idleTimer.unref?.()
}

async function getOrCreateAgent(input) {
  const key = `${input.openlinkUserId}:${input.sessionId}`
  const needsFiles = (input.attachments || []).some((item) => item?.type === 'file' || item?.type === 'image')
  let active = activeAgents.get(key)
  const agentKind = input.agent === 'omp' ? 'omp' : 'pi'
  const runtimeIdentity = runtimeConfigurationIdentity(input.runtimeConfiguration)
  if (active && (active.projectRef !== input.projectRef || active.projectId !== input.openlinkProjectId
    || active.agentKind !== agentKind || active.input.expectedSubject !== input.expectedSubject
    || active.runtimeIdentity !== runtimeIdentity
    || !['terminal', 'files', 'exec'].every((capability) => active.capabilities.includes(capability))
    || (needsFiles && !active.capabilities.includes('files')))) {
    if (active.busy) throw new Error('SESSION_BUSY')
    if (active.idleTimer) clearTimeout(active.idleTimer)
    activeAgents.delete(key)
    await active.agent.close().catch(() => undefined)
    await clearCheckpoint(active.input).catch(() => undefined)
    active = null
  }
  if (active?.busy) throw new Error('SESSION_BUSY')
  if (!active) {
    const opened = await createCloudAgent({ ...input, agent: agentKind })
    active = {
      ...opened,
      input,
      userId: input.openlinkUserId,
      projectId: input.openlinkProjectId,
      projectRef: input.projectRef,
      sessionId: input.sessionId,
      runtimeIdentity,
      busy: false,
      promptRun: null,
      idleTimer: null,
    }
    activeAgents.set(key, active)
  } else if (active.idleTimer) {
    clearTimeout(active.idleTimer)
    active.idleTimer = null
  }
  if (active) await active.agent.setModel(input.runtimeConfiguration.providerId, input.runtimeConfiguration.modelId)
  return { key, active }
}

async function handleComputerInfo(input, response) {
  if (!validAuthorization(input)) return json(response, 400, { error: 'INVALID_BODY' })
  const sdk = await cloudSdk(input)
  await verifyIdentity(sdk, input)
  const info = await sdk.project(input.projectRef).computer.info({ signal: AbortSignal.timeout(12_000) })
  json(response, 200, {
    computer: {
      project: input.projectRef,
      plan: typeof info.plan === 'string' ? info.plan : null,
      status: info.container_status === 'running' || info.container_status === 'sleeping' ? info.container_status : 'unknown',
    },
  })
}

async function handleComputerServices(input, response) {
  if (!validAuthorization(input)) return json(response, 400, { error: 'INVALID_BODY' })
  let computer
  try {
    const sdk = await cloudSdk(input)
    await verifyIdentity(sdk, input)
    const info = await sdk.project(input.projectRef).computer.info({ signal: AbortSignal.timeout(12_000) })
    if (info.container_status !== 'running') {
      return json(response, 200, {
        computerStatus: info.container_status === 'sleeping' ? 'sleeping' : 'unknown',
        services: [],
      })
    }
    computer = await sdk.openComputerStream(input.projectRef, {
      capabilities: ['ports'],
      idempotencyKey: `openlink-discover-${randomUUID()}`,
      requestTimeoutMs: 30_000,
    })
    const services = await computer.discoverServices()
    return json(response, 200, {
      computerStatus: 'running',
      services: services.flatMap((service) => {
        const safeService = publicComputerService(service)
        return safeService ? [safeService] : []
      }),
    })
  } catch (error) {
    return json(response, 502, { error: sdkErrorCode(error) })
  } finally {
    await computer?.close().catch(() => undefined)
  }
}

async function handleComputerServiceTunnel(input, response) {
  if (!validAuthorization(input, true) || !validComputerServiceId(input.serviceId)) {
    return json(response, 400, { error: 'INVALID_BODY' })
  }
  try {
    const zoneConfiguration = configuredComputerServiceZones()
    if (zoneConfiguration.error) return json(response, 503, { error: zoneConfiguration.error })
    const sdk = await cloudSdk(input)
    await verifyIdentity(sdk, input)
    const info = await sdk.project(input.projectRef).computer.info({ signal: AbortSignal.timeout(12_000) })
    if (info.container_status !== 'running') {
      return json(response, 409, { error: 'COMPUTER_SERVICE_NOT_RUNNING' })
    }
    const computer = await sdk.openComputerStream(input.projectRef, {
      capabilities: ['ports'],
      idempotencyKey: `openlink-tunnel-${randomUUID()}`,
      requestTimeoutMs: 30_000,
    })
    try {
      const services = await computer.discoverServices()
      const service = services.find((candidate) => candidate.id === input.serviceId)
      if (!service || service.status !== 'running') {
        return json(response, 409, { error: 'COMPUTER_SERVICE_NOT_RUNNING' })
      }
      const tunnel = await computer.createServiceTunnel(input.serviceId)
      const safeService = publicComputerService(tunnel.service)
      if (!safeService || safeService.id !== input.serviceId || safeService.status !== 'running') {
        return json(response, 502, { error: 'COMPUTER_SERVICE_TUNNEL_INVALID' })
      }
      return json(response, 200, {
        tunnel: {
          projectRef: tunnel.projectRef,
          service: safeService,
          url: tunnel.url,
          expiresAt: tunnel.expiresAt,
        },
      })
    } finally {
      await computer.close().catch(() => undefined)
    }
  } catch (error) {
    return json(response, 502, { error: sdkErrorCode(error) })
  }
}

async function handleLease(input, response) {
  if (!validAgentContext(input)) return json(response, 400, { error: 'INVALID_BODY' })
  try {
    const { key, active } = await getOrCreateAgent(input)
    scheduleAgentCleanup(key, active)
    json(response, 200, { ready: true, agent: active.agentKind })
  } catch (error) {
    return json(response, error instanceof Error && error.message === 'SESSION_BUSY' ? 409 : 502, {
      error: error instanceof Error && error.message === 'SESSION_BUSY' ? 'SESSION_BUSY' : sdkErrorCode(error),
    })
  }
}

async function handleResources(input, response) {
  if (!validAgentContext(input)) return json(response, 400, { error: 'INVALID_BODY' })
  let key
  let active
  try {
    const created = await getOrCreateAgent({ ...input, attachments: [] })
    key = created.key
    active = created.active
    const commands = await active.agent.getCommands()
    json(response, 200, {
      agent: active.agentKind,
      source: active.agentKind === 'omp' ? 'Oh My Pi RPC' : 'Pi RPC',
      accessMode: 'restricted',
      mcpServers: [],
      imageGeneration: false,
      commands: commands.flatMap((item) => {
        if (!item || typeof item !== 'object') return []
        const command = item
        return typeof command.name === 'string'
          ? [{ name: command.name.slice(0, 80), description: typeof command.description === 'string' ? command.description.slice(0, 256) : '', source: typeof command.source === 'string' ? command.source.slice(0, 32) : 'builtin' }]
          : []
      }),
      models: [],
    })
  } catch (error) {
    return json(response, error instanceof Error && error.message === 'SESSION_BUSY' ? 409 : 502, {
      error: error instanceof Error && error.message === 'SESSION_BUSY' ? 'SESSION_BUSY' : sdkErrorCode(error),
    })
  } finally {
    if (active) scheduleAgentCleanup(key, active)
  }
}

async function handleAgentEvents(input, response) {
  if (!validAgentContext(input, true)) return json(response, 400, { error: 'INVALID_BODY' })
  let key
  let active
  try {
    const created = await getOrCreateAgent(input)
    key = created.key
    active = created.active
  } catch (error) {
    if (error instanceof Error && error.message === 'SESSION_BUSY') return json(response, 409, { error: 'SESSION_BUSY' })
    return json(response, 502, { error: sdkErrorCode(error) })
  }

  active.busy = true
  response.writeHead(200, {
    'cache-control': 'no-cache, no-transform',
    'content-type': 'application/x-ndjson; charset=utf-8',
    'x-accel-buffering': 'no',
  })
  let closed = false
  const writeRecord = (record) => {
    if (!response.destroyed && !response.writableEnded) response.write(`${JSON.stringify(record)}\n`)
  }
  const removeListener = active.agent.onRecord(writeRecord)
  const onClientClose = () => {
    if (response.writableEnded || closed) return
    void (active.promptRun ? active.promptRun.abort() : active.agent.abort()).catch(() => undefined)
  }
  response.once('close', onClientClose)
  try {
    const prompt = await promptWithAttachments(active.agent, input)
    active.promptRun = await active.agent.prompt(prompt, { timeoutMs: 300_000 })
    await active.promptRun.completion
    if (active.agentKind === 'pi') {
      const entries = await active.agent.getEntries()
      if (entries.entries.length) {
        const state = await active.agent.getState()
        writeRecord({
          type: 'openlink_session_entries',
          header: {
            type: 'session',
            id: typeof state.sessionId === 'string' ? state.sessionId : active.agent.agentSessionId,
            timestamp: new Date().toISOString(),
            cwd: '/workspace',
          },
          entries: entries.entries,
          leafId: entries.leafId,
        })
      }
    }
  } catch (error) {
    if (!response.destroyed && !response.writableEnded) {
      writeRecord({ type: 'extension_error', error: error instanceof Error && error.message === 'CLOUD_ATTACHMENT_TOO_LARGE'
        ? 'This Cloud Computer accepts attachments up to 32 KiB until the Workspace SDK supports chunked upload.'
        : 'Cloud Computer agent request failed', terminal: true })
    }
  } finally {
    closed = true
    response.removeListener('close', onClientClose)
    removeListener()
    active.busy = false
    active.promptRun = null
    scheduleAgentCleanup(key, active)
    if (!response.destroyed && !response.writableEnded) response.end()
  }
}

async function handleControl(input, response) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || !uuid.test(input.userId ?? '') || !uuid.test(input.projectId ?? '')
    || !uuid.test(input.workspaceId ?? '') || !chatSessionId.test(input.sessionId ?? '')
    || typeof input.action !== 'string') return json(response, 400, { error: 'INVALID_BODY' })
  const key = `${input.userId}:${input.sessionId}`
  const active = activeAgents.get(key)
  if (!active || active.projectId !== input.projectId || active.sessionId !== input.sessionId) {
    return json(response, 409, { error: 'AGENT_SESSION_NOT_ACTIVE' })
  }
  try {
    let result
    if (input.action === 'status') {
      const state = await active.agent.getState()
      result = { state, busy: active.busy || state.isStreaming === true }
    }
    else if (input.action === 'interrupt') {
      await active.agent.abort()
      result = { interrupted: true }
    } else if (input.action === 'steer' && typeof input.text === 'string' && input.text.trim()) {
      result = { accepted: await active.agent.steer(input.text) }
    } else if (input.action === 'follow-up' && typeof input.text === 'string' && input.text.trim()) {
      result = { accepted: await active.agent.followUp(input.text) }
    } else {
      return json(response, 400, { error: 'CONTROL_UNSUPPORTED' })
    }
    return json(response, 200, { result, paused: false })
  } catch {
    return json(response, 502, { error: 'AGENT_CONTROL_UNAVAILABLE' })
  }
}

async function handleCancel(input, response) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || !uuid.test(input.userId ?? '') || !uuid.test(input.projectId ?? '')
    || !uuid.test(input.workspaceId ?? '') || !chatSessionId.test(input.sessionId ?? '')) {
    return json(response, 400, { error: 'INVALID_BODY' })
  }
  const active = activeAgents.get(`${input.userId}:${input.sessionId}`)
  if (!active || active.projectId !== input.projectId) return json(response, 200, { cancelled: false })
  try {
    if (active.promptRun) await active.promptRun.abort()
    else await active.agent.abort()
    return json(response, 200, { cancelled: true })
  } catch {
    return json(response, 502, { error: 'AGENT_CANCEL_UNAVAILABLE' })
  }
}

const server = createServer(async (request, response) => {
  const requestUrl = new URL(request.url || '/', 'http://127.0.0.1')
  if (request.method === 'GET' && requestUrl.pathname === '/healthz') {
    return json(response, 200, { status: 'ok', service: 'cloud-computer-host' })
  }
  if (!hasInternalAuthorization(request)) return json(response, 401, { error: 'UNAUTHORIZED' })
  if (request.method !== 'POST') return json(response, 404, { error: 'NOT_FOUND' })

  let input
  try {
    input = await readJson(request)
  } catch (error) {
    return json(response, error instanceof Error && error.message === 'body-too-large' ? 413 : 400, { error: 'INVALID_BODY' })
  }

  try {
    if (requestUrl.pathname === '/v1/computer/info') return await handleComputerInfo(input, response)
    if (requestUrl.pathname === '/v1/computer/services') return await handleComputerServices(input, response)
    if (requestUrl.pathname === '/v1/computer/services/tunnel') return await handleComputerServiceTunnel(input, response)
    const match = requestUrl.pathname.match(/^\/v1\/agent\/sessions\/([A-Za-z0-9]{11})\/(events|lease|resources|control|cancel)$/)
    if (!match || input.sessionId !== match[1]) return json(response, 404, { error: 'NOT_FOUND' })
    if (match[2] === 'events') return await handleAgentEvents(input, response)
    if (match[2] === 'lease') return await handleLease(input, response)
    if (match[2] === 'resources') return await handleResources(input, response)
    if (match[2] === 'control') return await handleControl(input, response)
    return await handleCancel(input, response)
  } catch {
    if (!response.headersSent) return json(response, 502, { error: 'CLOUD_COMPUTER_UNAVAILABLE' })
    if (!response.destroyed && !response.writableEnded) response.end()
  }
})

server.requestTimeout = 0
server.headersTimeout = 20_000
server.keepAliveTimeout = 75_000
server.listen(port, host)
