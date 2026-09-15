import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { CodexAppServerRuntime, codexThreadReferenceText } from '../../services/agent-worker/dist/codex-runtime.js'

test('editing rewinds the native target and descendants rather than steering or prompting', async () => {
  const runtime = new CodexAppServerRuntime({ workspaceRoot: '/unused', sessionRoot: '/unused', codexHome: '/unused', codexBin: 'unused', accessMode: 'restricted' })
  runtime.ensureThread = async () => 'thread'
  runtime.structuredPromptInput = async (text) => [{ type: 'text', text }]
  const calls = []
  runtime.request = async (method, params) => {
    calls.push({ method, params })
    if (method === 'thread/revert') return { thread: { id: 'thread', turns: [] } }
    return { thread: { turns: ['first', 'original', 'later'].map((text, index) => ({ id: `turn-${index}`, items: [{ type: 'userMessage', content: [{ type: 'text', text }] }] })) } }
  }
  assert.deepEqual(await runtime.control({ action: 'rewind', text: 'original' }), { rewound: true })
  assert.deepEqual(calls[1], { method: 'thread/revert', params: { threadId: 'thread', beforeTurnId: 'turn-1' } })
  calls.length = 0
  await assert.rejects(runtime.control({ action: 'rewind', text: 'missing' }), /unambiguously/)
  assert.equal(calls.length, 1)
  runtime.busy = true
  await assert.rejects(runtime.control({ action: 'rewind', text: 'original' }), /active turn/)
})

test('editing falls back to count rollback for older native turns without ids', async () => {
  const runtime = new CodexAppServerRuntime({ workspaceRoot: '/unused', sessionRoot: '/unused', codexHome: '/unused', codexBin: 'unused', accessMode: 'restricted' })
  runtime.ensureThread = async () => 'thread'
  runtime.structuredPromptInput = async (text) => [{ type: 'text', text }]
  const calls = []
  runtime.request = async (method, params) => {
    calls.push({ method, params })
    if (method === 'thread/rollback') return { thread: { turns: [{}] } }
    return { thread: { turns: ['first', 'original', 'later'].map((text) => ({ items: [{ type: 'userMessage', content: [{ type: 'text', text }] }] })) } }
  }
  assert.deepEqual(await runtime.control({ action: 'rewind', text: 'original' }), { rewound: true })
  assert.deepEqual(calls[1], { method: 'thread/rollback', params: { threadId: 'thread', numTurns: 2 } })
})

test('Codex handshake opts into the native collaboration protocol', () => {
  const source = readFileSync(new URL('../../services/agent-worker/src/codex-runtime.ts', import.meta.url), 'utf8')
  assert.match(source, /request\('initialize',\s*\{\s*capabilities:\s*\{\s*experimentalApi:\s*true/)
})

test('each access mode reaches Codex thread start as its exact sandbox and approval policy', async () => {
  const cases = [
    ['restricted', 'read-only', 'never'],
    ['ask', 'workspace-write', 'on-request'],
    ['open', 'danger-full-access', 'never'],
  ]
  for (const [accessMode, sandbox, approvalPolicy] of cases) {
    const dir = await mkdtemp('/tmp/openlink-access-policy-')
    try {
      const runtime = new CodexAppServerRuntime({ workspaceRoot: dir, sessionRoot: dir, codexHome: dir, codexBin: 'unused', accessMode })
      const calls = []
      runtime.request = async (method, params) => { calls.push({ method, params }); return { thread: { id: `${accessMode}-thread` } } }
      assert.equal(await runtime.restoreOrStartThread(), `${accessMode}-thread`)
      assert.equal(calls[0].method, 'thread/start')
      assert.equal(calls[0].params.sandbox, sandbox)
      assert.equal(calls[0].params.approvalPolicy, approvalPolicy)
    } finally { await rm(dir, { recursive: true, force: true }) }
  }
})

test('Plan questions round-trip answers and preserve native request id types', async () => {
  const runtime = new CodexAppServerRuntime({ workspaceRoot: '/unused', sessionRoot: '/unused', codexHome: '/unused', codexBin: 'unused', accessMode: 'restricted' })
  const frames = [], responses = []
  runtime.emitToUi = (frame) => { frames.push(frame); return true }
  runtime.child = { killed: false, stdin: { write: (line) => responses.push(JSON.parse(line)) } }
  runtime.onFrame(JSON.stringify({ id: 7, method: 'item/tool/requestUserInput', params: { questions: [
    { id: 'direction', header: '方向', question: '选择方向', options: [{ label: 'A' }, { label: 'B' }] },
    { id: 'detail', header: '补充', question: '补充说明', options: null },
  ] } }))
  assert.equal(frames[0].method, 'select')
  assert.equal(frames[0].requestKind, 'question')
  assert.equal(frames[1].method, 'input')
  assert.equal(frames[1].requestKind, 'question')
  await runtime.resolveApproval('input:7:0', false, 'A')
  assert.equal(responses.length, 0)
  await runtime.resolveApproval('input:7:1', false)
  assert.deepEqual(responses[0], { id: 7, result: { answers: { direction: { answers: ['A'] }, detail: { answers: [] } } } })
  runtime.onFrame(JSON.stringify({ id: 8, method: 'item/commandExecution/requestApproval', params: { command: 'pwd' } }))
  assert.equal(frames.find((frame) => frame.id === 'exec:8')?.requestKind, 'approval')
  await runtime.resolveApproval('exec:8', true)
  assert.deepEqual(responses[1], { id: 8, result: { decision: 'accept' } })
  runtime.onFrame(JSON.stringify({ id: 'unknown', method: 'future/unsupported', params: {} }))
  assert.equal(responses[2].error.code, -32601)
})

test('goal and steering call native scoped protocols, never ordinary prompt text', async () => {
  const runtime = new CodexAppServerRuntime({ workspaceRoot: '/workspace', sessionRoot: '/unused', codexHome: '/unused', codexBin: 'unused', accessMode: 'restricted' })
  runtime.ensureThread = async () => 'thread'
  const calls = []
  runtime.request = async (method, params) => { calls.push({ method, params }); return {} }
  runtime.emitToUi = () => true
  await runtime.control({ action: 'goal', text: 'Complete tests' })
  assert.deepEqual(calls[0], { method: 'thread/goal/set', params: { threadId: 'thread', objective: 'Complete tests', status: 'active' } })
  await assert.rejects(runtime.control({ action: 'steer', text: 'focus' }), /No active turn/)
  runtime.busy = true
  runtime.activeTurnId = 'turn'
  await runtime.control({ action: 'steer', text: 'focus' })
  assert.equal(calls[1].method, 'turn/steer')
  assert.equal(calls[1].params.expectedTurnId, 'turn')
  await assert.rejects(runtime.control({ action: 'goal', text: 'other' }), /active turn/)
})

test('fork creates a distinct native Codex thread without replacing the source thread', async () => {
  const runtime = new CodexAppServerRuntime({ workspaceRoot: '/workspace', sessionRoot: '/unused', codexHome: '/unused', codexBin: 'unused', accessMode: 'ask', providerId: 'test', model: 'test/model' })
  runtime.ensureThread = async () => 'source-thread'
  const calls = []
  runtime.request = async (method, params) => {
    calls.push({ method, params })
    return { thread: { id: '11111111-1111-4111-8111-111111111111' } }
  }
  assert.deepEqual(await runtime.control({ action: 'fork' }), { forked: true, threadId: '11111111-1111-4111-8111-111111111111' })
  assert.equal(calls[0].method, 'thread/fork')
  assert.deepEqual(calls[0].params, { threadId: 'source-thread' })
  assert.equal(runtime.threadId, null)
})

test('Codex image attachments become native image input without synthetic prompt text', async () => {
  const runtime = new CodexAppServerRuntime({ workspaceRoot: '/workspace', sessionRoot: '/unused', codexHome: '/unused', codexBin: 'unused', accessMode: 'restricted' })
  const attachment = { type: 'image', mediaType: 'image/png', url: 'data:image/png;base64,aGVsbG8=', filename: 'sample.png' }
  assert.deepEqual(await runtime.structuredPromptInput('', [attachment]), [{ type: 'image', imageUrl: attachment.url }])
  assert.deepEqual(await runtime.structuredPromptInput('describe', [attachment]), [
    { type: 'text', text: 'describe', text_elements: [] },
    { type: 'image', imageUrl: attachment.url },
  ])
})

test('uploaded files are staged inside the workspace and become native mentions', async () => {
  const workspace = await mkdtemp('/tmp/openlink-codex-upload-')
  try {
    const runtime = new CodexAppServerRuntime({ workspaceRoot: workspace, sessionRoot: workspace, codexHome: workspace, codexBin: 'unused', accessMode: 'restricted' })
    const content = Buffer.from('hello')
    const attachment = {
      type: 'file', uploadId: '11111111-1111-4111-8111-111111111111', batchId: '22222222-2222-4222-8222-222222222222',
      mediaType: 'text/plain', filename: 'notes.txt', relativePath: 'sample/docs/notes.txt', sizeBytes: content.length,
      sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824', contentBase64: content.toString('base64'),
    }
    assert.deepEqual(await runtime.structuredPromptInput('review', [attachment]), [
      { type: 'text', text: 'review', text_elements: [] },
      { type: 'mention', name: 'notes.txt', path: '.openlink/uploads/22222222-2222-4222-8222-222222222222/sample/docs/notes.txt' },
    ])
  } finally { await rm(workspace, { recursive: true, force: true }) }
})

test('Codex pasted text remains an atomic native text input item', async () => {
  const runtime = new CodexAppServerRuntime({ workspaceRoot: '/workspace', sessionRoot: '/unused', codexHome: '/unused', codexBin: 'unused', accessMode: 'restricted' })
  const attachment = { type: 'text', mediaType: 'text/plain', text: 'verbatim pasted context', filename: '已粘贴的文本.txt' }
  assert.deepEqual(await runtime.structuredPromptInput('review this', [attachment]), [
    { type: 'text', text: 'review this', text_elements: [] },
    { type: 'text', text: attachment.text, text_elements: [] },
  ])
})

test('Codex task references preserve titles as UTF-8 text elements and bounded thread context', () => {
  const result = codexThreadReferenceText('检查这个任务', [
    { name: '修复 数据库', path: 'thread://task-123' },
    { name: '重复项', path: 'thread://task-123' },
  ])
  assert.match(result.text, /"threadId":"task-123"/)
  assert.match(result.text, /\[@修复 数据库\]\(thread:\/\/task-123\)$/)
  assert.equal(result.text_elements.length, 1)
  const element = result.text_elements[0]
  assert.equal(element.placeholder, '@修复 数据库')
  assert.equal(Buffer.from(result.text).subarray(element.byte_range.start, element.byte_range.end).toString(), '[@修复 数据库](thread://task-123)')
})

test('selected file references become native mentions only after exact workspace resolution', async () => {
  const runtime = new CodexAppServerRuntime({ workspaceRoot: '/workspace', sessionRoot: '/unused', codexHome: '/unused', codexBin: 'unused', accessMode: 'restricted' })
  runtime.request = async (method) => method === 'fuzzyFileSearch'
    ? { files: [{ path: 'src/app.ts', file_name: 'app.ts' }] }
    : { data: [] }
  assert.deepEqual(await runtime.structuredPromptInput('review', [{ type: 'reference', referenceType: 'file', name: 'app.ts', path: 'src/app.ts' }]), [
    { type: 'text', text: 'review', text_elements: [] },
    { type: 'mention', name: 'app.ts', path: 'src/app.ts' },
  ])
  assert.deepEqual(await runtime.structuredPromptInput('review', [{ type: 'reference', referenceType: 'file', name: 'secret', path: '../secret' }]), [
    { type: 'text', text: 'review', text_elements: [] },
  ])
})

test('native skills augment the complete prompt text instead of replacing typed syntax', async () => {
  const runtime = new CodexAppServerRuntime({ workspaceRoot: '/workspace', sessionRoot: '/unused', codexHome: '/unused', codexBin: 'unused', accessMode: 'restricted' })
  runtime.request = async (method) => {
    if (method === 'skills/list') return { data: [{ skills: [{ name: 'frontend', path: '/skills/frontend/SKILL.md', enabled: true }] }] }
    if (method === 'app/list') return { data: [] }
    return null
  }
  assert.deepEqual(await runtime.structuredPromptInput('请使用 $frontend 修复布局'), [
    { type: 'text', text: '请使用 $frontend 修复布局', text_elements: [] },
    { type: 'skill', name: 'frontend', path: '/skills/frontend/SKILL.md' },
  ])
})

test('explicit native resource drawers distinguish protocol failure from an empty result', async () => {
  const runtime = new CodexAppServerRuntime({ workspaceRoot: '/workspace', sessionRoot: '/unused', codexHome: '/unused', codexBin: 'unused', accessMode: 'restricted' })
  runtime.threadId = 'thread'
  runtime.start = async () => {}
  runtime.request = async (method) => { throw new Error(`${method} unavailable`) }
  for (const command of ['skills', 'plugins', 'apps']) {
    await assert.rejects(runtime.resources({ scope: 'command', command, query: '' }), /unavailable/)
  }
  assert.deepEqual((await runtime.resources({ scope: 'mention', query: '' })).items, [])
})

test('plan state is written only after native capability is confirmed', async () => {
  const dir = await mkdtemp('/tmp/openlink-controls-')
  try {
    const runtime = new CodexAppServerRuntime({ workspaceRoot: dir, sessionRoot: dir, codexHome: dir, codexBin: 'unused', accessMode: 'restricted' })
    runtime.ensureThread = async () => 'thread'
    runtime.request = async () => ({ data: [{ mode: 'plan', name: 'Plan' }, { mode: 'default', name: 'Code' }] })
    assert.deepEqual(await runtime.control({ action: 'plan' }), { mode: 'plan' })
    assert.equal(runtime.collaborationMode, 'plan')
    runtime.request = async () => ({ data: [] })
    await assert.rejects(runtime.control({ action: 'default' }), /does not support/)
    assert.equal(runtime.collaborationMode, 'plan')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('model changes preserve native history and resume failures cannot silently erase it', async () => {
  const dir = await mkdtemp('/tmp/openlink-resume-control-')
  try {
    const options = { workspaceRoot: dir, sessionRoot: dir, codexHome: dir, codexBin: 'unused', accessMode: 'restricted', providerId: 'test', model: 'test/first' }
    const previous = new CodexAppServerRuntime(options)
    await previous.persistThreadId('durable-thread')
    const next = new CodexAppServerRuntime({ ...options, model: 'test/second' })
    assert.equal(await next.persistedThreadId(), 'durable-thread')
    const calls = []
    next.request = async (method, params) => { calls.push({ method, params }); return { thread: { id: 'durable-thread' } } }
    assert.equal(await next.restoreOrStartThread(), 'durable-thread')
    assert.equal(calls[0].method, 'thread/resume')
    assert.equal(calls[0].params.model, 'second')
    next.request = async () => { throw new Error('temporary initialization error') }
    await assert.rejects(next.restoreOrStartThread(), /temporary initialization/)
    next.request = async (method) => {
      if (method === 'thread/resume') throw new Error('no rollout found for thread id durable-thread')
      return { thread: { id: 'replacement-after-missing-rollout' } }
    }
    assert.equal(await next.restoreOrStartThread(), 'replacement-after-missing-rollout')
  } finally { await rm(dir, { recursive: true, force: true }) }
})
