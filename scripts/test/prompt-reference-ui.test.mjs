import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const textarea = readFileSync(new URL('../../components/agent-prompt-textarea.tsx', import.meta.url), 'utf8')
const workspace = readFileSync(new URL('../../components/chat-workspace.tsx', import.meta.url), 'utf8')
const home = readFileSync(new URL('../../components/workspace-prompt.tsx', import.meta.url), 'utf8')
const serializer = readFileSync(new URL('../../lib/agent-runtime/serialize-prompt-attachments.client.ts', import.meta.url), 'utf8')

test('selected files and tasks leave editable text and become removable input references', () => {
  assert.match(textarea, /selectedAsReference/)
  assert.match(textarea, /item\.action \|\| selectedAsReference \? '' : item\.insertText/)
  assert.match(workspace, /aria-label="引用"/)
  assert.match(workspace, /移除引用 \$\{attachment\.name\}/)
})

test('references serialize with queued and direct prompt attachments', () => {
  assert.match(workspace, /await serializePromptAttachments\(sessionId, files, pastedTextAttachments, referenceAttachments, instructionAttachments\)/)
  assert.match(serializer, /`\/api\/chat\/\$\{encodeURIComponent\(sessionId\)\}\/uploads`/)
  assert.match(serializer, /\{ relativePath: file\.relativePath \}/)
  assert.match(workspace, /setReferenceAttachments\(\[\]\)/)
})

test('uploads are agent-independent and instructions render as protocol attachments', () => {
  const menu = readFileSync(new URL('../../components/prompt-add-menu.tsx', import.meta.url), 'utf8')
  const worker = readFileSync(new URL('../../services/agent-worker/src/main.ts', import.meta.url), 'utf8')
  assert.match(workspace, /attachmentsEnabled\n/)
  assert.match(home, /<PromptAddMenu variant="home" agent=\{agentKind\} attachmentsEnabled \/>/)
  assert.match(home, /await serializePromptAttachments\(result\.id, files\)/)
  assert.match(home, /`\/api\/chat\/\$\{encodeURIComponent\(result\.id\)\}\/queue`/)
  assert.match(home, /autoStart: files\.length === 0/)
  assert.doesNotMatch(workspace, /ATTACHMENTS_UNSUPPORTED/)
  assert.doesNotMatch(menu, /当前 Agent 不支持/)
  assert.doesNotMatch(worker, /attachments are not supported by this agent/)
  assert.match(workspace, /aria-label="指令"/)
  assert.match(menu, /onAddInstruction\?\./)
  assert.doesNotMatch(menu, /function instructionPrompt/)
})

test('the composer exposes file and folder input while retaining lightweight upload handles', () => {
  const promptInput = readFileSync(new URL('../../components/ai-elements/prompt-input.tsx', import.meta.url), 'utf8')
  const menu = readFileSync(new URL('../../components/prompt-add-menu.tsx', import.meta.url), 'utf8')
  assert.match(promptInput, /webkitdirectory/)
  assert.match(promptInput, /batchId/)
  assert.match(menu, /PromptInputActionAddFolder/)
  assert.match(serializer, /AgentPromptFileAttachment/)
  assert.match(serializer, /id: file\.uploadId/)
  assert.match(serializer, /Boolean\(file\.relativePath\) \|\| !file\.mediaType\.startsWith\('image\/'\)/)
})
