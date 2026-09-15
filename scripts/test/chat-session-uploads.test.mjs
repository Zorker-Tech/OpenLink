import assert from 'node:assert/strict'
import { mkdtemp, readFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { parsePromptAttachments } from '../../lib/agent-runtime/prompt-attachments.ts'
import { stageCodexPromptFiles } from '../../services/agent-worker/dist/codex-runtime.js'

const migration = await readFile(new URL('../../zorkerbase/migrations/20260908130000_chat_session_uploads.sql', import.meta.url), 'utf8')

const upload = {
  type: 'file',
  uploadId: '11111111-1111-4111-8111-111111111111',
  batchId: '22222222-2222-4222-8222-222222222222',
  filename: 'notes.txt',
  relativePath: 'sample/docs/notes.txt',
  mediaType: 'text/plain',
  sizeBytes: 5,
  sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
}

test('parses metadata-only uploads and rejects traversal or duplicate handles', () => {
  assert.deepEqual(parsePromptAttachments([upload]), [upload])
  assert.equal(parsePromptAttachments([{ ...upload, relativePath: '../secret' }]), null)
  assert.equal(parsePromptAttachments([{ ...upload, filename: 'bad/name' }]), null)
  assert.equal(parsePromptAttachments([upload, upload]), null)
})

test('preserves bounded instruction protocol attachments', () => {
  const instruction = { type: 'instruction', name: 'Project instructions', text: 'Use the repository conventions.' }
  assert.deepEqual(parsePromptAttachments([instruction]), [instruction])
  assert.equal(parsePromptAttachments([{ ...instruction, text: '' }]), null)
})

test('stages uploaded files atomically and preserves folder hierarchy as native mentions', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'openlink-chat-upload-'))
  const mentions = await stageCodexPromptFiles(workspace, [{ ...upload, contentBase64: Buffer.from('hello').toString('base64') }])
  assert.deepEqual(mentions, [{ type: 'mention', name: 'notes.txt', path: '.openlink/uploads/22222222-2222-4222-8222-222222222222/sample/docs/notes.txt' }])
  assert.equal(await readFile(join(workspace, mentions[0].path), 'utf8'), 'hello')
})

test('refuses a symlinked upload control directory', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'openlink-chat-upload-symlink-'))
  const outside = await mkdtemp(join(tmpdir(), 'openlink-chat-upload-outside-'))
  await symlink(outside, join(workspace, '.openlink'))
  await assert.rejects(
    stageCodexPromptFiles(workspace, [{ ...upload, contentBase64: Buffer.from('hello').toString('base64') }]),
    /safe directory/,
  )
})

test('upload storage is owner-scoped, content-checked, quota-bounded, and not directly granted', () => {
  assert.match(migration, /auth\.uid\(\) <> p_user_id/)
  assert.match(migration, /decode\(content_base64, 'base64'\)/)
  assert.match(migration, /upload_bytes \+ p_size_bytes > 268435456/)
  assert.match(migration, /revoke all on table openlink\.chat_session_uploads from anon, authenticated/)
  assert.match(migration, /order by array_position\(p_ids, upload\.id\)/)
})
