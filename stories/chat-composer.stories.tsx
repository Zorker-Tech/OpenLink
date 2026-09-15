import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { expect, fireEvent, userEvent, waitFor, within } from 'storybook/test'
import { useEffect, useMemo, useRef, useState } from 'react'

import { ChatComposer } from '@/components/chat-workspace'
import { ChatTimeline } from '@/components/chat-timeline'
import type { OpenLinkAgentEvent } from '@/lib/agent-runtime/events'
import type { ConfiguredModelOption } from '@/lib/ai-provider-types'
import type { QueuedChatPrompt } from '@/lib/chat-prompt-queue'
import type { AccessMode } from '@/lib/chat-sessions'
import type { CodexComposerResources, RuntimeComposerResources } from '@/lib/composer-resources'

const browserFetch: typeof fetch = globalThis.fetch.bind(globalThis)

const models: ConfiguredModelOption[] = [
  {
    id: 'openai:gpt-5',
    providerId: 'openai',
    providerName: 'OpenAI',
    modelId: 'gpt-5',
    name: 'GPT-5',
    logo: 'openai',
    isDefault: true,
  },
  {
    id: 'anthropic:claude-4',
    providerId: 'anthropic',
    providerName: 'Anthropic',
    modelId: 'claude-4',
    name: 'Claude 4',
    logo: 'anthropic',
    isDefault: false,
  },
]

const runtimeResources: RuntimeComposerResources = {
  agent: 'codex',
  source: 'Codex App Server',
  accessMode: 'restricted',
  mcpServers: [],
  imageGeneration: false,
  commands: [
    { name: 'review', description: 'Review uncommitted changes', source: 'builtin' },
    { name: 'fork', description: 'Fork this task', source: 'builtin' },
  ],
}

const resourceDrawerRuntimeResources: RuntimeComposerResources = {
  ...runtimeResources,
  commands: [
    ...runtimeResources.commands,
    { name: 'skills', description: 'Browse native skills', source: 'builtin' },
    { name: 'apps', description: 'Browse native apps', source: 'builtin' },
  ],
}

const availablePlugin: CodexComposerResources['plugins'][number] = {
  pluginId: 'available-plugin',
  name: 'available',
  marketplaceName: 'OpenAI',
  version: '2.0.0',
  installed: false,
  enabled: false,
  installPolicy: 'AVAILABLE',
  authPolicy: 'NONE',
  displayName: 'Available Plugin',
  shortDescription: 'Available from the current marketplace.',
  longDescription: 'A plugin used to verify Worker refresh and retry behavior through the real Composer.',
  developerName: 'OpenAI',
  category: 'Developer Tools',
  capabilities: ['skills', 'mcp'],
  homepage: null,
  repository: null,
  license: 'MIT',
  keywords: ['available'],
  websiteUrl: null,
  privacyPolicyUrl: null,
  termsOfServiceUrl: null,
  defaultPrompts: ['Use the available plugin'],
}

function jsonResponse(body: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  })
}

function ComposerFixture() {
  const [outcome, setOutcome] = useState('none')
  const originalFetch = useRef(browserFetch)
  const mockFetch = useMemo<typeof fetch>(() => async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const method = init?.method ?? (typeof input === 'string' || input instanceof URL ? 'GET' : input.method)
    if (url.endsWith('/queue') && method === 'GET') return jsonResponse({ items: [] })
    if (url.endsWith('/runtime-resources') && method === 'GET') return jsonResponse(runtimeResources)
    if (url.includes('/prompt-resources?') && method === 'GET') return jsonResponse({ items: [] })
    if (url.endsWith('/lease') && method === 'POST') return jsonResponse({ leased: true })
    if (url.endsWith('/control') && method === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}')) as { action?: string }
      if (body.action === 'status') return jsonResponse({ paused: false, result: { mode: 'default' } })
      if (body.action === 'fork') {
        setOutcome('fork:/owner/chat/child')
        return jsonResponse({
          result: { forked: true, threadId: 'native-child' },
          fork: { id: 'child', path: '/owner/chat/child' },
        })
      }
    }
    return jsonResponse({ error: `Unhandled story request: ${method} ${url}` }, { status: 500 })
  }, [])

  // Install before the child mounts so its initial queue/status effects exercise
  // the same fetch-backed paths as production. Each Storybook iframe owns this
  // global, and cleanup restores the original implementation.
  globalThis.fetch = mockFetch
  useEffect(() => () => {
    if (globalThis.fetch === mockFetch) globalThis.fetch = originalFetch.current
  }, [mockFetch])

  return (
    <main className="flex min-h-screen items-end justify-center bg-[var(--app-background)] p-12 text-[var(--app-foreground)]">
      <div className="w-full max-w-2xl">
        <p className="mb-4 text-sm text-[var(--app-muted)]" data-testid="composer-outcome">Outcome: {outcome}</p>
        <ChatComposer
          accessMode="restricted"
          codexResources={null}
          composerResources={{ agent: 'codex', customInstructions: '', skills: [] }}
          context={null}
          initialModel={{ providerId: 'openai', modelId: 'gpt-5' }}
          models={models}
          onAccessModeChange={async () => true}
          onFork={(path) => setOutcome(`navigated:${path}`)}
          onInstallPlugin={async () => undefined}
          onInterrupt={() => undefined}
          onRename={() => setOutcome('renamed')}
          onSubmit={async (message, model) => {
            setOutcome(`submitted:${message}:${model?.providerId}/${model?.modelId}`)
            return true
          }}
          runtimeResources={runtimeResources}
          sessionId="storybook-session"
          status="idle"
        />
      </div>
    </main>
  )
}

function QueueFixture() {
  const [composerKey, setComposerKey] = useState(0)
  const [outcome, setOutcome] = useState('streaming')
  const [status, setStatus] = useState<'idle' | 'streaming'>('streaming')
  const queue = useRef<QueuedChatPrompt[]>([])
  const workerBusy = useRef(true)
  const originalFetch = useRef(browserFetch)
  const mockFetch = useMemo<typeof fetch>(() => async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const method = init?.method ?? (typeof input === 'string' || input instanceof URL ? 'GET' : input.method)
    if (url.endsWith('/queue') && method === 'GET') return jsonResponse({ items: queue.current })
    if (url.endsWith('/queue') && method === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}')) as { id: string; message: string; attachments: []; model: QueuedChatPrompt['model'] }
      const item: QueuedChatPrompt = {
        id: body.id,
        text: body.message,
        attachments: body.attachments,
        model: body.model,
        claimed: false,
        createdAt: '2026-09-09T00:00:00.000Z',
      }
      queue.current = [...queue.current, item]
      return jsonResponse({ item }, { status: 201 })
    }
    if (url.endsWith('/queue') && method === 'PATCH') {
      const body = JSON.parse(String(init?.body ?? '{}')) as { action?: string; id?: string }
      if (body.action === 'claim') {
        const item = queue.current.find((candidate) => !candidate.claimed)
        if (!item) return new Response(null, { status: 204 })
        const claimed = { ...item, claimed: true, claimToken: 'storybook-private-claim-token' }
        queue.current = queue.current.map((candidate) => candidate.id === item.id ? claimed : candidate)
        return jsonResponse({ item: claimed })
      }
      if (body.action === 'complete') {
        queue.current = queue.current.filter((candidate) => candidate.id !== body.id)
        return jsonResponse({ ok: true })
      }
      if (body.action === 'release') {
        queue.current = queue.current.map((candidate) => candidate.id === body.id ? { ...candidate, claimed: false } : candidate)
        return jsonResponse({ ok: true })
      }
    }
    if (url.endsWith('/runtime-resources') && method === 'GET') return jsonResponse(runtimeResources)
    if (url.includes('/prompt-resources?') && method === 'GET') return jsonResponse({ items: [] })
    if (url.endsWith('/control') && method === 'POST') return jsonResponse({ paused: false, result: { mode: 'default', busy: workerBusy.current } })
    return jsonResponse({ error: `Unhandled story request: ${method} ${url}` }, { status: 500 })
  }, [])

  globalThis.fetch = mockFetch
  useEffect(() => () => {
    if (globalThis.fetch === mockFetch) globalThis.fetch = originalFetch.current
  }, [mockFetch])

  return (
    <main className="flex min-h-screen items-end justify-center bg-[var(--app-background)] p-12 text-[var(--app-foreground)]">
      <div className="w-full max-w-2xl">
        <div className="mb-4 flex items-center gap-3 text-sm text-[var(--app-muted)]">
          <span data-testid="queue-outcome">Outcome: {outcome}</span>
          <button onClick={() => setComposerKey((value) => value + 1)} type="button">重新挂载 Composer</button>
          <button onClick={() => { workerBusy.current = false; setStatus('idle'); setOutcome('idle') }} type="button">结束当前回复</button>
        </div>
        <ChatComposer
          key={composerKey}
          accessMode="restricted"
          codexResources={null}
          composerResources={{ agent: 'codex', customInstructions: '', skills: [] }}
          context={null}
          initialModel={{ providerId: 'openai', modelId: 'gpt-5' }}
          models={models}
          onAccessModeChange={async () => true}
          onFork={() => undefined}
          onInstallPlugin={async () => undefined}
          onInterrupt={() => undefined}
          onRename={() => undefined}
          onSubmit={async (message, model, options) => {
            setOutcome(`drained:${message}:${model?.providerId}/${model?.modelId}`)
            options?.onAccepted?.()
            return true
          }}
          runtimeResources={runtimeResources}
          sessionId="storybook-queue-session"
          status={status}
        />
      </div>
    </main>
  )
}

function UploadFixture() {
  const [outcome, setOutcome] = useState('none')
  const [uploadRequest, setUploadRequest] = useState('none')
  const originalFetch = useRef(browserFetch)
  const mockFetch = useMemo<typeof fetch>(() => async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const method = init?.method ?? (typeof input === 'string' || input instanceof URL ? 'GET' : input.method)
    if (url.startsWith('blob:')) return browserFetch(input, init)
    if (url.endsWith('/queue') && method === 'GET') return jsonResponse({ items: [] })
    if (url.endsWith('/runtime-resources') && method === 'GET') return jsonResponse(runtimeResources)
    if (url.endsWith('/control') && method === 'POST') return jsonResponse({ paused: false, result: { mode: 'default' } })
    if (url.endsWith('/uploads') && method === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        files?: Array<{ id: string; batchId: string; filename: string; mediaType: string; dataUrl: string }>
      }
      const file = body.files?.[0]
      if (!file) return jsonResponse({ error: 'INVALID_FILES' }, { status: 400 })
      const contentBase64 = file.dataUrl.split(',')[1] ?? ''
      setUploadRequest(`${file.filename}:${file.mediaType}:${atob(contentBase64)}`)
      return jsonResponse({
        attachments: [{
          type: 'file',
          uploadId: file.id,
          batchId: file.batchId,
          filename: file.filename,
          mediaType: file.mediaType,
          sizeBytes: atob(contentBase64).length,
          sha256: 'a'.repeat(64),
        }],
      }, { status: 201 })
    }
    return jsonResponse({ error: `Unhandled story request: ${method} ${url}` }, { status: 500 })
  }, [])

  globalThis.fetch = mockFetch
  useEffect(() => () => {
    if (globalThis.fetch === mockFetch) globalThis.fetch = originalFetch.current
  }, [mockFetch])

  return (
    <main className="flex min-h-screen items-end justify-center bg-[var(--app-background)] p-12 text-[var(--app-foreground)]">
      <div className="w-full max-w-2xl">
        <p className="mb-2 text-sm text-[var(--app-muted)]" data-testid="upload-request">Upload request: {uploadRequest}</p>
        <p className="mb-4 text-sm text-[var(--app-muted)]" data-testid="upload-outcome">Outcome: {outcome}</p>
        <ChatComposer
          accessMode="restricted"
          codexResources={null}
          composerResources={{ agent: 'codex', customInstructions: '', skills: [] }}
          context={null}
          initialModel={{ providerId: 'openai', modelId: 'gpt-5' }}
          models={models}
          onAccessModeChange={async () => true}
          onFork={() => undefined}
          onInstallPlugin={async () => undefined}
          onInterrupt={() => undefined}
          onRename={() => undefined}
          onSubmit={async (message, model, options) => {
            const attachment = options?.attachments?.[0]
            setOutcome(attachment?.type === 'file'
              ? `file:${message || '(empty)'}:${attachment.filename}:${attachment.mediaType}:${attachment.sizeBytes}:${model?.providerId}/${model?.modelId}`
              : 'missing-native-file-attachment')
            return true
          }}
          runtimeResources={runtimeResources}
          sessionId="storybook-upload-session"
          status="idle"
        />
      </div>
    </main>
  )
}

function AccessModeFixture() {
  const [accessMode, setAccessMode] = useState<AccessMode>('restricted')
  const [resources, setResources] = useState<RuntimeComposerResources>({ ...runtimeResources, accessMode: 'restricted' })
  const [attempt, setAttempt] = useState('none')
  const originalFetch = useRef(browserFetch)
  const mockFetch = useMemo<typeof fetch>(() => async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const method = init?.method ?? (typeof input === 'string' || input instanceof URL ? 'GET' : input.method)
    if (url.endsWith('/queue') && method === 'GET') return jsonResponse({ items: [] })
    if (url.endsWith('/runtime-resources') && method === 'GET') return jsonResponse(runtimeResources)
    if (url.endsWith('/control') && method === 'POST') return jsonResponse({ paused: false, result: { mode: 'default' } })
    return jsonResponse({ error: `Unhandled story request: ${method} ${url}` }, { status: 500 })
  }, [])

  globalThis.fetch = mockFetch
  useEffect(() => () => {
    if (globalThis.fetch === mockFetch) globalThis.fetch = originalFetch.current
  }, [mockFetch])

  return (
    <main className="flex min-h-screen items-end justify-center bg-[var(--app-background)] p-12 text-[var(--app-foreground)]">
      <div className="w-full max-w-2xl">
        <p className="mb-4 text-sm text-[var(--app-muted)]" data-testid="access-mode-outcome">Mode: {accessMode}; attempt: {attempt}</p>
        <ChatComposer
          accessMode={accessMode}
          codexResources={null}
          composerResources={{ agent: 'codex', customInstructions: '', skills: [] }}
          context={null}
          initialModel={{ providerId: 'openai', modelId: 'gpt-5' }}
          models={models}
          onAccessModeChange={async (mode) => {
            setAttempt(mode)
            if (mode !== 'ask') return false
            setAccessMode(mode)
            setResources((current) => ({ ...current, accessMode: mode }))
            return true
          }}
          onFork={() => undefined}
          onInstallPlugin={async () => undefined}
          onInterrupt={() => undefined}
          onRename={() => undefined}
          onSubmit={async () => true}
          runtimeResources={resources}
          sessionId="storybook-access-mode-session"
          status="idle"
        />
      </div>
    </main>
  )
}

function PluginInstallFixture() {
  const [attempts, setAttempts] = useState(0)
  const [resources, setResources] = useState<CodexComposerResources>({ skills: [], plugins: [availablePlugin] })
  const originalFetch = useRef(browserFetch)
  const mockFetch = useMemo<typeof fetch>(() => async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const method = init?.method ?? (typeof input === 'string' || input instanceof URL ? 'GET' : input.method)
    if (url.endsWith('/queue') && method === 'GET') return jsonResponse({ items: [] })
    if (url.endsWith('/runtime-resources') && method === 'GET') return jsonResponse(runtimeResources)
    if (url.endsWith('/control') && method === 'POST') return jsonResponse({ paused: false, result: { mode: 'default' } })
    return jsonResponse({ error: `Unhandled story request: ${method} ${url}` }, { status: 500 })
  }, [])

  globalThis.fetch = mockFetch
  useEffect(() => () => {
    if (globalThis.fetch === mockFetch) globalThis.fetch = originalFetch.current
  }, [mockFetch])

  return (
    <main className="flex min-h-screen items-end justify-center bg-[var(--app-background)] p-12 text-[var(--app-foreground)]">
      <div className="w-full max-w-2xl">
        <p className="mb-4 text-sm text-[var(--app-muted)]" data-testid="plugin-install-outcome">Install attempts: {attempts}</p>
        <ChatComposer
          accessMode="restricted"
          codexResources={resources}
          composerResources={{ agent: 'codex', customInstructions: '', skills: [] }}
          context={null}
          initialModel={{ providerId: 'openai', modelId: 'gpt-5' }}
          models={models}
          onAccessModeChange={async () => true}
          onFork={() => undefined}
          onInstallPlugin={async () => {
            const attempt = attempts + 1
            setAttempts(attempt)
            if (attempt === 1) throw new Error('Worker 未确认插件可用')
            setResources({ skills: [], plugins: [{ ...availablePlugin, installed: true, enabled: true }] })
          }}
          onInterrupt={() => undefined}
          onRename={() => undefined}
          onSubmit={async () => true}
          runtimeResources={runtimeResources}
          sessionId="storybook-plugin-install-session"
          status="idle"
        />
      </div>
    </main>
  )
}

function ResourceDrawerFixture() {
  const [resourceRequest, setResourceRequest] = useState('none')
  const [submitOutcome, setSubmitOutcome] = useState('none')
  const originalFetch = useRef(browserFetch)
  const mockFetch = useMemo<typeof fetch>(() => async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const method = init?.method ?? (typeof input === 'string' || input instanceof URL ? 'GET' : input.method)
    if (url.endsWith('/queue') && method === 'GET') return jsonResponse({ items: [] })
    if (url.endsWith('/runtime-resources') && method === 'GET') return jsonResponse(resourceDrawerRuntimeResources)
    if (url.includes('/prompt-resources?') && method === 'GET') {
      const command = new URL(url, globalThis.location.href).searchParams.get('command') ?? 'none'
      setResourceRequest(command)
      if (command === 'skills') return jsonResponse({ items: [] })
      if (command === 'apps') return jsonResponse({ error: 'CODEX_RESOURCE_UNAVAILABLE' }, { status: 503 })
    }
    if (url.endsWith('/control') && method === 'POST') return jsonResponse({ paused: false, result: { mode: 'default' } })
    return jsonResponse({ error: `Unhandled story request: ${method} ${url}` }, { status: 500 })
  }, [])

  globalThis.fetch = mockFetch
  useEffect(() => () => {
    if (globalThis.fetch === mockFetch) globalThis.fetch = originalFetch.current
  }, [mockFetch])

  return (
    <main className="flex min-h-screen items-end justify-center bg-[var(--app-background)] p-12 text-[var(--app-foreground)]">
      <div className="w-full max-w-2xl">
        <p className="mb-2 text-sm text-[var(--app-muted)]" data-testid="resource-request">Resource request: {resourceRequest}</p>
        <p className="mb-4 text-sm text-[var(--app-muted)]" data-testid="resource-submit">Submit: {submitOutcome}</p>
        <ChatComposer
          accessMode="restricted"
          codexResources={{ skills: [], plugins: [] }}
          composerResources={{ agent: 'codex', customInstructions: '', skills: [] }}
          context={null}
          initialModel={{ providerId: 'openai', modelId: 'gpt-5' }}
          models={models}
          onAccessModeChange={async () => true}
          onFork={() => undefined}
          onInstallPlugin={async () => undefined}
          onInterrupt={() => undefined}
          onRename={() => undefined}
          onSubmit={async (message) => { setSubmitOutcome(message); return true }}
          runtimeResources={resourceDrawerRuntimeResources}
          sessionId="storybook-resource-drawer-session"
          status="idle"
        />
      </div>
    </main>
  )
}

function ForkFailureFixture() {
  const [status, setStatus] = useState<'idle' | 'streaming'>('idle')
  const [forkAttempts, setForkAttempts] = useState(0)
  const [queueAttempts, setQueueAttempts] = useState(0)
  const [controlAttempts, setControlAttempts] = useState(0)
  const [navigation, setNavigation] = useState('none')
  const originalFetch = useRef(browserFetch)
  const mockFetch = useMemo<typeof fetch>(() => async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const method = init?.method ?? (typeof input === 'string' || input instanceof URL ? 'GET' : input.method)
    if (url.endsWith('/queue') && method === 'GET') return jsonResponse({ items: [] })
    if (url.endsWith('/queue') && method === 'POST') {
      setQueueAttempts((current) => current + 1)
      return jsonResponse({ error: 'native commands cannot be queued' }, { status: 409 })
    }
    if (url.endsWith('/runtime-resources') && method === 'GET') return jsonResponse(runtimeResources)
    if (url.endsWith('/control') && method === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}')) as { action?: string }
      if (body.action === 'status') return jsonResponse({ paused: false, result: { mode: 'default' } })
      if (body.action === 'fork') {
        setForkAttempts((current) => current + 1)
        return jsonResponse({ error: '原生 Fork 暂时不可用' }, { status: 503 })
      }
      setControlAttempts((current) => current + 1)
      return jsonResponse({ paused: false, result: { mode: body.action === 'plan' ? 'plan' : 'default' } })
    }
    return jsonResponse({ error: `Unhandled story request: ${method} ${url}` }, { status: 500 })
  }, [])

  globalThis.fetch = mockFetch
  useEffect(() => () => {
    if (globalThis.fetch === mockFetch) globalThis.fetch = originalFetch.current
  }, [mockFetch])

  return (
    <main className="flex min-h-screen items-end justify-center bg-[var(--app-background)] p-12 text-[var(--app-foreground)]">
      <div className="w-full max-w-2xl">
        <div className="mb-4 flex items-center gap-3 text-sm text-[var(--app-muted)]">
          <span data-testid="fork-outcome">Fork attempts: {forkAttempts}; queue attempts: {queueAttempts}; control attempts: {controlAttempts}; navigation: {navigation}; status: {status}</span>
          <button onClick={() => setStatus('streaming')} type="button">开始回复</button>
          <button onClick={() => setStatus('idle')} type="button">结束回复</button>
        </div>
        <ChatComposer
          accessMode="restricted"
          codexResources={null}
          composerResources={{ agent: 'codex', customInstructions: '', skills: [] }}
          context={null}
          initialModel={{ providerId: 'openai', modelId: 'gpt-5' }}
          models={models}
          onAccessModeChange={async () => true}
          onFork={(path) => setNavigation(path)}
          onInstallPlugin={async () => undefined}
          onInterrupt={() => undefined}
          onRename={() => undefined}
          onSubmit={async () => true}
          runtimeResources={runtimeResources}
          sessionId="storybook-fork-failure-session"
          status={status}
        />
      </div>
    </main>
  )
}

const editFixtureEvents: OpenLinkAgentEvent[] = [
  { version: 1, id: 'event-user-original', sequence: 1, sessionId: 'storybook-edit-session', timestamp: '2026-09-09T00:00:00.000Z', source: 'codex', type: 'message.user', messageId: 'message-original', text: '保留原始身份' },
  { version: 1, id: 'event-answer-original', sequence: 2, sessionId: 'storybook-edit-session', timestamp: '2026-09-09T00:00:01.000Z', source: 'codex', type: 'message.completed', messageId: 'answer-original', text: '这条旧回复应在重发后消失' },
  { version: 1, id: 'event-user-later', sequence: 3, sessionId: 'storybook-edit-session', timestamp: '2026-09-09T00:00:02.000Z', source: 'codex', type: 'message.user', messageId: 'message-later', text: '这条后续消息也应被裁剪' },
  { version: 1, id: 'event-answer-later', sequence: 4, sessionId: 'storybook-edit-session', timestamp: '2026-09-09T00:00:03.000Z', source: 'codex', type: 'message.completed', messageId: 'answer-later', text: '后续分支回复' },
]

function EditResendFixture() {
  const [events, setEvents] = useState(editFixtureEvents)
  const [streaming, setStreaming] = useState(false)
  const [outcome, setOutcome] = useState('Attempts: 0; message: none')
  const attempts = useRef(0)

  return (
    <main className="flex min-h-screen flex-col bg-[var(--app-background)] p-8 text-[var(--app-foreground)]">
      <div className="mx-auto mb-3 flex w-full max-w-2xl items-center gap-3 text-sm text-[var(--app-muted)]">
        <span data-testid="edit-outcome">{outcome}; status: {streaming ? 'streaming' : 'idle'}</span>
        <button onClick={() => setStreaming(true)} type="button">开始回复</button>
        <button onClick={() => setStreaming(false)} type="button">结束回复</button>
      </div>
      <div className="mx-auto flex min-h-0 w-full max-w-2xl flex-1 overflow-hidden rounded-xl border border-[var(--app-border)] bg-[var(--app-surface)]">
        <ChatTimeline
          events={events}
          isStreaming={streaming}
          onEditMessage={async (messageId, text) => {
            attempts.current += 1
            setOutcome(`Attempts: ${attempts.current}; message: ${messageId}; draft: ${text}`)
            if (attempts.current % 2 === 1) throw new Error('原生回退未确认，修改内容已保留')
            setEvents((current) => [...current,
              { version: 1, id: `event-user-revision-${attempts.current}`, sequence: 10 + attempts.current, sessionId: 'storybook-edit-session', timestamp: '2026-09-09T00:01:00.000Z', source: 'codex', type: 'message.user', messageId, replacesMessageId: messageId, text },
              { version: 1, id: `event-answer-revision-${attempts.current}`, sequence: 20 + attempts.current, sessionId: 'storybook-edit-session', timestamp: '2026-09-09T00:01:01.000Z', source: 'codex', type: 'message.completed', messageId: `answer-revision-${attempts.current}`, text: '这是重新生成的新分支回复' },
            ])
          }}
        />
      </div>
    </main>
  )
}

function PlanGoalFixture() {
  const [controls, setControls] = useState<string[]>([])
  const [submits, setSubmits] = useState(0)
  const onFork = useMemo(() => (_path: string) => undefined, [])
  const originalFetch = useRef(browserFetch)
  const mockFetch = useMemo<typeof fetch>(() => async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const method = init?.method ?? (typeof input === 'string' || input instanceof URL ? 'GET' : input.method)
    if (url.endsWith('/queue') && method === 'GET') return jsonResponse({ items: [] })
    if (url.endsWith('/runtime-resources') && method === 'GET') return jsonResponse(runtimeResources)
    if (url.includes('/prompt-resources?') && method === 'GET') return jsonResponse({ items: [] })
    if (url.endsWith('/control') && method === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}')) as { action?: string; text?: string }
      if (body.action === 'status') return jsonResponse({ paused: false, result: { mode: 'default' } })
      setControls((current) => [...current, body.action ?? 'unknown'])
      if (body.action === 'plan') return jsonResponse({ paused: false, result: { mode: 'plan' } })
      if (body.action === 'default') return jsonResponse({ paused: false, result: { mode: 'default' } })
      if (body.action === 'goal') return jsonResponse({ paused: false, result: { goal: { objective: body.text, status: 'active', tokensUsed: 0 } } })
      if (body.action === 'goal-clear') return jsonResponse({ paused: false, result: { goal: null } })
    }
    return jsonResponse({ error: `Unhandled story request: ${method} ${url}` }, { status: 500 })
  }, [])

  globalThis.fetch = mockFetch
  useEffect(() => () => {
    if (globalThis.fetch === mockFetch) globalThis.fetch = originalFetch.current
  }, [mockFetch])

  return (
    <main className="flex min-h-screen items-end justify-center bg-[var(--app-background)] p-12 text-[var(--app-foreground)]">
      <div className="w-full max-w-2xl">
        <p className="mb-4 text-sm text-[var(--app-muted)]" data-testid="plan-goal-outcome">Controls: {controls.join(',') || 'none'}; submits: {submits}</p>
        <ChatComposer
          accessMode="restricted"
          codexResources={null}
          composerResources={{ agent: 'codex', customInstructions: '', skills: [] }}
          context={null}
          initialModel={{ providerId: 'openai', modelId: 'gpt-5' }}
          models={models}
          onAccessModeChange={async () => true}
          onFork={onFork}
          onInstallPlugin={async () => undefined}
          onInterrupt={() => undefined}
          onRename={() => undefined}
          onSubmit={async () => { setSubmits((current) => current + 1); return true }}
          runtimeResources={runtimeResources}
          sessionId="storybook-plan-goal-session"
          status="idle"
        />
      </div>
    </main>
  )
}

const meta = {
  title: 'Product/Chat Composer',
  component: ChatComposer,
  parameters: { a11y: { test: 'error' }, layout: 'fullscreen' },
} satisfies Meta<typeof ChatComposer>

export default meta
type Story = StoryObj<typeof meta>

async function openAvailablePlugin(canvasElement: HTMLElement) {
  const canvas = within(canvasElement)
  const page = within(canvasElement.ownerDocument.body)
  await userEvent.click(canvas.getByRole('button', { name: '打开添加菜单' }))
  const plugins = await page.findByRole('menuitem', { name: /Plugins/ })
  plugins.focus()
  await userEvent.keyboard('{ArrowRight}')
  const managePlugins = await page.findByRole('menuitem', { name: '管理 Codex 插件' })
  managePlugins.focus()
  await userEvent.keyboard('{Enter}')
  const dialog = await page.findByRole('dialog', { name: 'Codex 插件市场' })
  await userEvent.click(within(dialog).getByRole('button', { name: /Available Plugin/ }))
  return { canvas, dialog, page }
}

export const ReviewAndFork: Story = {
  render: () => <ComposerFixture />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const textbox = canvas.getByRole('textbox', { name: '描述你想创建的内容' })
    const outcome = canvas.getByTestId('composer-outcome')

    await userEvent.type(textbox, '/review focus on auth boundaries')
    await userEvent.click(canvas.getByRole('button', { name: '发送' }))
    await waitFor(() => expect(outcome).toHaveTextContent('submitted:/review focus on auth boundaries:openai/gpt-5'))
    await expect(textbox).toHaveValue('')

    await userEvent.type(textbox, '/fork')
    await userEvent.click(canvas.getByRole('button', { name: '发送' }))
    await waitFor(() => expect(outcome).toHaveTextContent('navigated:/owner/chat/child'))
    await expect(textbox).toHaveValue('')
  },
}

export const KeyboardCompositionAndEscape: Story = {
  render: () => <ComposerFixture />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const textbox = canvas.getByRole('textbox', { name: '描述你想创建的内容' })
    const combobox = canvas.getByRole('combobox', { name: '描述你想创建的内容' })
    const outcome = canvas.getByTestId('composer-outcome')

    await userEvent.type(textbox, 'line one')
    await userEvent.keyboard('{Shift>}{Enter}{/Shift}')
    await userEvent.type(textbox, 'line two')
    await expect(textbox).toHaveValue('line one\nline two')

    fireEvent.keyDown(textbox, { key: 'Enter', code: 'Enter', keyCode: 13, isComposing: true })
    fireEvent.keyDown(textbox, { key: 'Enter', code: 'Enter', keyCode: 229, isComposing: false })
    await expect(outcome).toHaveTextContent('Outcome: none')
    await expect(textbox).toHaveValue('line one\nline two')

    await userEvent.keyboard('{Enter}')
    await waitFor(() => expect(outcome.textContent).toBe('Outcome: submitted:line one\nline two:openai/gpt-5'))
    await expect(textbox).toHaveValue('')

    await userEvent.type(textbox, '/')
    await expect(combobox).toHaveAttribute('aria-expanded', 'true')
    await userEvent.keyboard('{Escape}')
    await expect(combobox).toHaveAttribute('aria-expanded', 'false')
    await expect(textbox).toHaveValue('/')
  },
}

export const ConfiguredModelAndClientActions: Story = {
  render: () => <ComposerFixture />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const page = within(canvasElement.ownerDocument.body)
    const textbox = canvas.getByRole('textbox', { name: '描述你想创建的内容' })
    const outcome = canvas.getByTestId('composer-outcome')

    await userEvent.click(canvas.getByRole('button', { name: '选择模型，当前 GPT-5' }))
    await userEvent.click(await page.findByText('Claude 4'))
    await userEvent.type(textbox, 'use configured model')
    await userEvent.click(canvas.getByRole('button', { name: '发送' }))
    await waitFor(() => expect(outcome).toHaveTextContent('submitted:use configured model:anthropic/claude-4'))
    await waitFor(() => expect(textbox).toHaveValue(''))

    await userEvent.type(textbox, '/model upstream-only-model')
    await userEvent.click(canvas.getByRole('button', { name: '发送' }))
    await expect(await canvas.findByRole('alert')).toHaveTextContent('该模型不在当前已配置模型中')
    await expect(textbox).toHaveValue('/model upstream-only-model')

    await userEvent.clear(textbox)
    await userEvent.type(textbox, '/status')
    await userEvent.click(canvas.getByRole('button', { name: '发送' }))
    await expect(await canvas.findByRole('region', { name: '会话状态' })).toBeVisible()
    await expect(textbox).toHaveValue('')
    await expect(outcome).toHaveTextContent('submitted:use configured model:anthropic/claude-4')
    await expect(canvas.queryByRole('alert')).not.toBeInTheDocument()

    await userEvent.click(canvas.getByRole('button', { name: '关闭会话状态' }))
    await userEvent.type(textbox, '/rename')
    await userEvent.click(canvas.getByRole('button', { name: '发送' }))
    await waitFor(() => expect(outcome).toHaveTextContent('renamed'))
    await expect(textbox).toHaveValue('')
    await expect(canvas.queryByRole('alert')).not.toBeInTheDocument()
  },
}

export const DurableQueueReloadAndDrain: Story = {
  render: () => <QueueFixture />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    let textbox = canvas.getByRole('textbox', { name: '描述你想创建的内容' })

    await userEvent.type(textbox, 'queued after current turn')
    await userEvent.click(canvas.getByRole('button', { name: '加入队列' }))
    await expect(await canvas.findByLabelText('消息队列')).toHaveTextContent('1 条消息已排队')
    await expect(canvas.getByLabelText('消息队列')).toHaveTextContent('queued after current turn')

    await userEvent.click(canvas.getByRole('button', { name: '重新挂载 Composer' }))
    textbox = await canvas.findByRole('textbox', { name: '描述你想创建的内容' })
    await expect(await canvas.findByLabelText('消息队列')).toHaveTextContent('queued after current turn')
    await expect(textbox).toHaveValue('')

    await userEvent.click(canvas.getByRole('button', { name: '结束当前回复' }))
    await waitFor(() => expect(canvas.getByTestId('queue-outcome')).toHaveTextContent('drained:queued after current turn:openai/gpt-5'))
    await waitFor(() => expect(canvas.queryByLabelText('消息队列')).not.toBeInTheDocument())
    await expect(canvas.queryByRole('alert')).not.toBeInTheDocument()
  },
}

export const PrivateFileUpload: Story = {
  render: () => <UploadFixture />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const page = within(canvasElement.ownerDocument.body)
    const fileInput = canvas.getByLabelText('Upload files') as HTMLInputElement
    const originalClick = fileInput.click.bind(fileInput)
    let pickerOpenAttempts = 0
    fileInput.click = () => { pickerOpenAttempts += 1 }
    try {
      await userEvent.click(canvas.getByRole('button', { name: '打开添加菜单' }))
      await userEvent.click(await page.findByRole('menuitem', { name: 'Upload files' }))
      await expect(pickerOpenAttempts).toBe(1)
    } finally {
      fileInput.click = originalClick
    }
    const file = new File(['{"mode":"ask"}'], 'config.json', { type: 'application/json' })
    await userEvent.upload(fileInput, file)
    await expect(await canvas.findByText('config.json')).toBeVisible()

    await userEvent.click(canvas.getByRole('button', { name: '发送' }))
    await waitFor(() => expect(canvas.getByTestId('upload-request')).toHaveTextContent('config.json:application/json:{"mode":"ask"}'))
    await waitFor(() => expect(canvas.getByTestId('upload-outcome')).toHaveTextContent('file:(empty):config.json:application/json:14:openai/gpt-5'))
    await expect(canvas.queryByText('config.json')).not.toBeInTheDocument()
    await expect(canvas.queryByRole('alert')).not.toBeInTheDocument()
  },
}

export const AccessModeCommitAndRollback: Story = {
  render: () => <AccessModeFixture />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const page = within(canvasElement.ownerDocument.body)
    const textbox = canvas.getByRole('textbox', { name: '描述你想创建的内容' })
    const outcome = canvas.getByTestId('access-mode-outcome')
    await userEvent.type(textbox, 'draft survives permissions')

    await userEvent.click(canvas.getByRole('button', { name: '打开添加菜单' }))
    const permissions = await page.findByRole('menuitem', { name: /权限/ })
    permissions.focus()
    await userEvent.keyboard('{ArrowRight}')
    const ask = await page.findByRole('menuitem', { name: '询问（写操作确认）' })
    ask.focus()
    await userEvent.keyboard('{Enter}')

    await waitFor(() => expect(outcome).toHaveTextContent('Mode: ask; attempt: ask'))
    await expect(canvas.queryByText('权限已在当前运行时生效')).not.toBeInTheDocument()
    await expect(textbox).toHaveValue('draft survives permissions')

    await userEvent.click(canvas.getByRole('button', { name: '打开添加菜单' }))
    const updatedPermissions = await page.findByRole('menuitem', { name: /权限/ })
    await expect(updatedPermissions).toHaveTextContent('询问')
    updatedPermissions.focus()
    await userEvent.keyboard('{ArrowRight}')
    const open = await page.findByRole('menuitem', { name: '开放（完全访问）' })
    open.focus()
    await userEvent.keyboard('{Enter}')

    await waitFor(() => expect(outcome).toHaveTextContent('Mode: ask; attempt: open'))
    await expect(await canvas.findByRole('alert')).toHaveTextContent('权限切换未生效，已恢复原权限')
    await expect(textbox).toHaveValue('draft survives permissions')
    for (let index = 0; index < 2 && page.queryAllByRole('menu').length; index += 1) await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(canvasElement.ownerDocument.querySelector('[data-base-ui-focus-guard]')).toBeNull())
  },
}

export const PluginInstallRetryAndWorkerActivation: Story = {
  render: () => <PluginInstallFixture />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const textbox = canvas.getByRole('textbox', { name: '描述你想创建的内容' })
    await userEvent.type(textbox, 'draft survives plugin install')
    const { dialog, page } = await openAvailablePlugin(canvasElement)
    const install = within(dialog).getByRole('button', { name: '安装插件' })

    await userEvent.click(install)
    await expect(await within(dialog).findByRole('alert')).toHaveTextContent('Worker 未确认插件可用')
    await expect(install).toBeEnabled()
    await expect(canvas.getByTestId('plugin-install-outcome')).toHaveTextContent('Install attempts: 1')
    await expect(textbox).toHaveValue('draft survives plugin install')

    await userEvent.click(install)
    await waitFor(() => expect(canvas.getByTestId('plugin-install-outcome')).toHaveTextContent('Install attempts: 2'))
    await expect(await within(dialog).findByRole('button', { name: '已安装并启用' })).toBeDisabled()
    await expect(canvas.queryByText('插件已安装，并在当前 Codex Worker 中生效')).not.toBeInTheDocument()
    await expect(textbox).toHaveValue('draft survives plugin install')

    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(page.queryByRole('dialog', { name: 'Codex 插件市场' })).not.toBeInTheDocument())
    await waitFor(() => expect(canvasElement.ownerDocument.querySelector('[data-base-ui-focus-guard]')).toBeNull())
  },
}

export const NativeResourceEmptyAndErrorStates: Story = {
  render: () => <ResourceDrawerFixture />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const textbox = canvas.getByRole('textbox', { name: '描述你想创建的内容' })

    await userEvent.type(textbox, '/')
    await userEvent.click(await canvas.findByRole('option', { name: /\/skills/ }))
    await expect(await canvas.findByRole('option', { name: '没有可用 Skills' })).toHaveAttribute('aria-disabled', 'true')
    await expect(canvas.getByTestId('resource-request')).toHaveTextContent('Resource request: skills')
    await expect(textbox).toHaveValue('/skills ')
    await expect(canvas.getByTestId('resource-submit')).toHaveTextContent('Submit: none')

    await userEvent.clear(textbox)
    await userEvent.type(textbox, '/')
    await userEvent.click(await canvas.findByRole('option', { name: /\/apps/ }))
    await expect(await canvas.findByRole('option', { name: '无法加载 Apps' })).toHaveAttribute('aria-disabled', 'true')
    await expect(canvas.getByTestId('resource-request')).toHaveTextContent('Resource request: apps')
    await expect(textbox).toHaveValue('/apps ')
    await expect(canvas.getByTestId('resource-submit')).toHaveTextContent('Submit: none')
  },
}

export const ForkFailureAndRunningGuard: Story = {
  render: () => <ForkFailureFixture />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const textbox = canvas.getByRole('textbox', { name: '描述你想创建的内容' })
    const outcome = canvas.getByTestId('fork-outcome')

    await userEvent.type(textbox, '/fork')
    await userEvent.click(canvas.getByRole('button', { name: '发送' }))
    await expect(await canvas.findByRole('alert')).toHaveTextContent('原生 Fork 暂时不可用')
    await expect(textbox).toHaveValue('/fork')
    await expect(outcome).toHaveTextContent('Fork attempts: 1; queue attempts: 0; control attempts: 0; navigation: none; status: idle')

    await userEvent.clear(textbox)
    await userEvent.click(canvas.getByRole('button', { name: '开始回复' }))
    await userEvent.type(textbox, '/')
    await expect(await canvas.findByRole('option', { name: /\/review/ })).toBeDisabled()
    await expect(canvas.getByRole('option', { name: /\/fork/ })).toBeDisabled()
    await userEvent.keyboard('{Escape}')

    await userEvent.clear(textbox)
    await userEvent.type(textbox, '/fork')
    await expect(await canvas.findByRole('option', { name: /\/fork/ })).toBeDisabled()
    await expect(textbox).not.toHaveAttribute('aria-activedescendant')
    await userEvent.keyboard('{Enter}')
    await expect(outcome).toHaveTextContent('Fork attempts: 1; queue attempts: 0; control attempts: 0; navigation: none; status: streaming')
    await expect(textbox).toHaveValue('/fork')
    await userEvent.keyboard('{Tab}')
    await expect(canvas.getByRole('combobox', { name: '描述你想创建的内容' })).toHaveAttribute('aria-expanded', 'false')
    await expect(textbox).not.toHaveFocus()
    await userEvent.click(canvas.getByRole('button', { name: '加入队列' }))
    await expect(await canvas.findByRole('alert')).toHaveTextContent('请等待当前回复结束后再创建分支')
    await expect(textbox).toHaveValue('/fork')
    await expect(outcome).toHaveTextContent('Fork attempts: 1; queue attempts: 0; control attempts: 0; navigation: none; status: streaming')

    await userEvent.clear(textbox)
    await userEvent.type(textbox, '/review focus on auth boundaries')
    await userEvent.click(canvas.getByRole('button', { name: '加入队列' }))
    await expect(await canvas.findByRole('alert')).toHaveTextContent('请等待当前回复结束后再开始 Review')
    await expect(textbox).toHaveValue('/review focus on auth boundaries')
    await expect(outcome).toHaveTextContent('Fork attempts: 1; queue attempts: 0; control attempts: 0; navigation: none; status: streaming')

    await userEvent.clear(textbox)
    await userEvent.type(textbox, '/plan')
    await userEvent.click(canvas.getByRole('button', { name: '加入队列' }))
    await expect(await canvas.findByRole('alert')).toHaveTextContent('请等待当前回复结束后再执行 /plan')
    await expect(textbox).toHaveValue('/plan')
    await expect(outcome).toHaveTextContent('Fork attempts: 1; queue attempts: 0; control attempts: 0; navigation: none; status: streaming')

    await userEvent.clear(textbox)
    await userEvent.type(textbox, '/goal')
    await userEvent.click(canvas.getByRole('button', { name: '加入队列' }))
    await expect(await canvas.findByRole('alert')).toHaveTextContent('请等待当前回复结束后再执行 /goal')
    await expect(textbox).toHaveValue('/goal')
    await expect(canvas.queryByRole('form', { name: '编辑 Goal' })).not.toBeInTheDocument()
    await expect(outcome).toHaveTextContent('Fork attempts: 1; queue attempts: 0; control attempts: 0; navigation: none; status: streaming')
  },
}

export const EditResendBranchAndRecovery: Story = {
  render: () => <EditResendFixture />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const outcome = canvas.getByTestId('edit-outcome')
    let edit = canvas.getByRole('button', { name: '编辑消息：保留原始身份' })

    await userEvent.click(edit)
    let editor = canvas.getByRole('textbox', { name: '消息内容' })
    await userEvent.clear(editor)
    await userEvent.type(editor, '取消的修改')
    await userEvent.keyboard('{Escape}')
    edit = canvas.getByRole('button', { name: '编辑消息：保留原始身份' })
    await expect(edit).toHaveFocus()
    await expect(canvas.queryByRole('form', { name: '编辑原消息' })).not.toBeInTheDocument()

    await userEvent.click(edit)
    editor = canvas.getByRole('textbox', { name: '消息内容' })
    await userEvent.clear(editor)
    await userEvent.type(editor, '修订后的消息')
    await userEvent.click(canvas.getByRole('button', { name: '重发' }))
    await expect(await canvas.findByRole('alert')).toHaveTextContent('原生回退未确认，修改内容已保留')
    await expect(editor).toHaveValue('修订后的消息')
    await expect(outcome).toHaveTextContent('Attempts: 1; message: message-original; draft: 修订后的消息')

    await userEvent.click(canvas.getByRole('button', { name: '重发' }))
    edit = await canvas.findByRole('button', { name: '编辑消息：修订后的消息' })
    await expect(outcome).toHaveTextContent('Attempts: 2; message: message-original; draft: 修订后的消息')
    await expect(await canvas.findByText('这是重新生成的新分支回复')).toBeVisible()
    await waitFor(() => expect(canvas.queryByText('这条旧回复应在重发后消失')).not.toBeInTheDocument())
    await waitFor(() => expect(canvas.queryByText('这条后续消息也应被裁剪')).not.toBeInTheDocument())

    await userEvent.click(canvas.getByRole('button', { name: '开始回复' }))
    await expect(edit).toBeDisabled()
    await userEvent.click(edit)
    await expect(canvas.queryByRole('form', { name: '编辑原消息' })).not.toBeInTheDocument()
    await userEvent.click(canvas.getByRole('button', { name: '结束回复' }))

    edit = canvas.getByRole('button', { name: '编辑消息：修订后的消息' })
    await userEvent.click(edit)
    editor = canvas.getByRole('textbox', { name: '消息内容' })
    await userEvent.clear(editor)
    await userEvent.type(editor, '失败后仍保留的再次修改')
    await userEvent.click(canvas.getByRole('button', { name: '重发' }))
    await expect(await canvas.findByRole('alert')).toHaveTextContent('原生回退未确认，修改内容已保留')
    await expect(editor).toHaveValue('失败后仍保留的再次修改')
    await expect(outcome).toHaveTextContent('Attempts: 3; message: message-original; draft: 失败后仍保留的再次修改; status: idle')
  },
}

export const PlanAndGoalNativeLifecycle: Story = {
  render: () => <PlanGoalFixture />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const textbox = canvas.getByRole('textbox', { name: '描述你想创建的内容' })
    const outcome = canvas.getByTestId('plan-goal-outcome')

    await userEvent.type(textbox, '草稿保留 /plan')
    await userEvent.click(await canvas.findByRole('option', { name: /\/plan/ }))
    await expect(await canvas.findByRole('button', { name: '退出 Plan 模式' })).toBeVisible()
    await expect(textbox).toHaveValue('草稿保留 ')
    await expect(outcome).toHaveTextContent('Controls: plan; submits: 0')

    await userEvent.type(textbox, '/goal')
    await userEvent.click(await canvas.findByRole('option', { name: /\/goal 编辑持续执行的目标/ }))
    const goalForm = await canvas.findByRole('form', { name: '编辑 Goal' })
    const goalEditor = within(goalForm).getByRole('textbox', { name: '目标' })
    await userEvent.type(goalEditor, '持续完成原始任务')
    await userEvent.click(within(goalForm).getByRole('button', { name: '设置目标' }))

    await waitFor(() => expect(canvas.queryByRole('button', { name: '退出 Plan 模式' })).not.toBeInTheDocument())
    await expect(await canvas.findByRole('button', { name: '清除 Goal' })).toBeVisible()
    await expect(canvas.getByText('持续完成原始任务')).toBeVisible()
    await expect(canvas.getByRole('button', { name: '清除 Goal' }).getBoundingClientRect().top).toBeLessThan(textbox.getBoundingClientRect().top)
    await expect(textbox).toHaveValue('草稿保留 ')
    await expect(outcome).toHaveTextContent('Controls: plan,default,goal; submits: 0')

    await userEvent.type(textbox, '/plan')
    await userEvent.click(await canvas.findByRole('option', { name: /\/plan/ }))
    await userEvent.click(await canvas.findByRole('button', { name: '退出 Plan 模式' }))
    await waitFor(() => expect(canvas.queryByRole('button', { name: '退出 Plan 模式' })).not.toBeInTheDocument())
    await expect(textbox).toHaveValue('草稿保留 ')

    await userEvent.click(canvas.getByRole('button', { name: '清除 Goal' }))
    await waitFor(() => expect(canvas.queryByRole('button', { name: '清除 Goal' })).not.toBeInTheDocument())
    await expect(outcome).toHaveTextContent('Controls: plan,default,goal,plan,default,goal-clear; submits: 0')
    await expect(canvas.queryByRole('alert')).not.toBeInTheDocument()
  },
}
