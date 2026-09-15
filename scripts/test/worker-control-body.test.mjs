import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Readable } from 'node:stream'
import { createHash } from 'node:crypto'
import ts from 'typescript'

const source = readFileSync(new URL('../../services/agent-worker/src/main.ts', import.meta.url), 'utf8')
const parsers = source.slice(source.indexOf('async function readRequestJson('), source.indexOf('async function readExtensionUiResponse('))
const { readRequestJson, readMessage, readPrompt } = new Function('createHash', ts.transpileModule(parsers, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText + '\nreturn { readRequestJson, readMessage, readPrompt }')(createHash)
const request = (body) => Readable.from([JSON.stringify(body)])
test('control bodies are parsed as JSON without a prompt message field', async () => {
  for (const action of ['status', 'plan', 'compact', 'rewind']) {
    const body = { action, text: '你好' }
    assert.deepEqual(await readRequestJson(request(body)), body)
  }
  assert.match(source, /const raw = await readRequestJson\(request, 128 \* 1024\)/)
  assert.doesNotMatch(source, /JSON.parse\(await readMessage\(request\)\)/)
  const host = readFileSync(new URL('../../services/agent-host/src/backends/local-opensandbox.ts', import.meta.url), 'utf8')
  assert.match(host, /body: JSON.stringify\(input\)/)
  assert.doesNotMatch(host, /message: JSON.stringify\(input\)/)
})
test('ordinary messages still require text and JSON body sizes stay bounded', async () => {
  assert.equal(await readMessage(request({ message: ' hello ' })), 'hello')
  await assert.rejects(readMessage(request({ action: 'rewind' })), /message is invalid/)
  await assert.rejects(readRequestJson(request({ text: 'too long' }), 4), /too large/)
})

test('image prompts accept bounded data URLs while rejecting unsupported or oversized attachments', async () => {
  const image = { type: 'image', mediaType: 'image/png', url: 'data:image/png;base64,aGVsbG8=', filename: 'sample.png' }
  assert.deepEqual(await readPrompt(request({ message: '', attachments: [image] })), { message: '', attachments: [image] })
  await assert.rejects(readPrompt(request({ message: '', attachments: [{ ...image, mediaType: 'text/plain' }] })), /attachments are invalid/)
  await assert.rejects(readPrompt(request({ message: '', attachments: [{ ...image, url: `data:image/png;base64,${'a'.repeat(3_000_001)}` }] })), /attachments are invalid/)
})

test('large pasted text is a bounded native text attachment', async () => {
  const attachment = { type: 'text', mediaType: 'text/plain', text: 'long pasted context', filename: '已粘贴的文本.txt' }
  assert.deepEqual(await readPrompt(request({ message: 'review this', attachments: [attachment] })), { message: 'review this', attachments: [attachment] })
  await assert.rejects(readPrompt(request({ message: '', attachments: [{ ...attachment, mediaType: 'text/html' }] })), /attachments are invalid/)
  await assert.rejects(readPrompt(request({ message: '', attachments: [{ ...attachment, text: 'a'.repeat(256 * 1024 + 1) }] })), /attachments are invalid/)
})

test('instructions remain structured until the runtime protocol adapter', async () => {
  const instruction = { type: 'instruction', name: '已保存的自定义指令', text: 'Always explain failures clearly.' }
  assert.deepEqual(await readPrompt(request({ message: 'review this', attachments: [instruction] })), { message: 'review this', attachments: [instruction] })
  await assert.rejects(readPrompt(request({ message: '', attachments: [{ ...instruction, text: '' }] })), /attachments are invalid/)
})

test('file and task references are bounded structured attachments', async () => {
  const attachments = [
    { type: 'reference', referenceType: 'file', name: 'app.ts', path: 'src/app.ts' },
    { type: 'reference', referenceType: 'thread', name: 'Previous task', path: 'thread://task-123' },
  ]
  assert.deepEqual(await readPrompt(request({ message: 'review', attachments })), { message: 'review', attachments })
  await assert.rejects(readPrompt(request({ message: 'review', attachments: [{ type: 'reference', referenceType: 'thread', name: 'bad', path: 'thread://../secret' }] })), /attachments are invalid/)
  await assert.rejects(readPrompt(request({ message: 'review', attachments: [{ type: 'reference', referenceType: 'file', name: 'bad', path: 'https://example.com/a' }] })), /attachments are invalid/)
})

test('uploaded files require exact content size and SHA-256 at the Worker boundary', async () => {
  const content = Buffer.from('hello')
  const attachment = {
    type: 'file',
    uploadId: '11111111-1111-4111-8111-111111111111',
    batchId: '22222222-2222-4222-8222-222222222222',
    mediaType: 'text/plain',
    filename: 'notes.txt',
    relativePath: 'sample/docs/notes.txt',
    sizeBytes: content.length,
    sha256: createHash('sha256').update(content).digest('hex'),
    contentBase64: content.toString('base64'),
  }
  assert.deepEqual(await readPrompt(request({ message: 'review', attachments: [attachment] })), { message: 'review', attachments: [attachment] })
  await assert.rejects(readPrompt(request({ message: 'review', attachments: [{ ...attachment, sha256: '0'.repeat(64) }] })), /attachments are invalid/)
  await assert.rejects(readPrompt(request({ message: 'review', attachments: [{ ...attachment, relativePath: '../secret' }] })), /attachments are invalid/)
})
