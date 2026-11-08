import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const chat = await readFile(new URL('../../components/chat-workspace.tsx', import.meta.url), 'utf8')
const sidebar = await readFile(new URL('../../components/app-workspace.tsx', import.meta.url), 'utf8')
const sessionPage = await readFile(new URL('../../app/[user_id]/chat/[chat_sessions_id]/page.tsx', import.meta.url), 'utf8')
const projectsPage = await readFile(new URL('../../app/app/[workspace_name]/projects/page.tsx', import.meta.url), 'utf8')
const projects = await readFile(new URL('../../components/projects-workspace.tsx', import.meta.url), 'utf8')
const legacyPreviewPage = await readFile(new URL('../../app/app/[workspace_name]/preview/page.tsx', import.meta.url), 'utf8')
const surfaces = await readFile(new URL('../../components/browser/workspace-surfaces.tsx', import.meta.url), 'utf8')
const previewSurface = await readFile(new URL('../../components/browser/native-preview-surface.tsx', import.meta.url), 'utf8')
const previewDesignPanel = await readFile(new URL('../../components/browser/preview-design-panel.tsx', import.meta.url), 'utf8')

test('Preview is a first-class tab in the chat workspace header', () => {
  assert.match(chat, /type WorkspaceTabId = SessionWorkspaceTab/)
  assert.match(chat, /\{ id: 'preview', label: t\('预览'\)/)
  assert.match(chat, /const \[openWorkspaceTabs, setOpenWorkspaceTabs\] = useState<WorkspaceTabId\[]>\(\['preview'\]\)/)
  assert.match(chat, /data-header-region="workspace-tabs"[\s\S]*?<WorkspaceTabs[\s\S]*?openTabs=\{openTabs\}/)
  assert.match(chat, /aria-label=\{t\('工作区标签'\)\}[\s\S]*?role="tablist"/)
  assert.match(chat, /aria-selected=\{selected\}[\s\S]*?role="tab"/)
  assert.match(chat, /id="preview-panel"[\s\S]*?<ChatTopbar \{\.\.\.chatTopbarProps\} side="workspace" \/>[\s\S]*?<WorkspaceSurfaces/)
  assert.match(sessionPage, /<ChatWorkspace[\s\S]*workspaceId=\{workspace\.id\}/)
})

test('project preview actions open a project chat and legacy links route to that flow', () => {
  assert.match(projects, /createChatSessionAction\(\{ workspaceSlug: activeWorkspace\.slug, projectId \}\)/)
  assert.match(projects, /router\.push\(result\.path\)/)
  assert.match(projectsPage, /initialPreviewProjectId=\{initialPreviewProjectId\}/)
  assert.match(legacyPreviewPage, /redirect\(`\/app\/\$\{workspaceName\}\/projects\?\$\{query\.toString\(\)\}`\)/)
  assert.doesNotMatch(legacyPreviewPage, /WorkspaceSurfaces|BrowserWorkbench/)
})

test('chat workspace Preview uses the native iframe workbench and keeps its toolbar beside it', () => {
  assert.match(surfaces, /<BrowserNavigationBar[\s\S]*?<main aria-label=\{t\('预览画布'\)\}/)
  assert.match(surfaces, /data-workspace-browser-surface="preview"[\s\S]*?<BrowserWorkbench[\s\S]*?initialSurface="native-preview"/)
  assert.match(surfaces, /selectPreviewTarget\(targetId, previewPagePaths\[targetId\]\)/)
  assert.match(surfaces, /previewViewportModes\[targetId\]/)
  assert.match(previewDesignPanel, /disabled=\{!canApplyDesign/)
  assert.match(chat, /accessMode: 'ask'/)
  assert.match(chat, /intent === 'design' && targetProjectId === projectId && accessMode === 'restricted'/)
  assert.match(previewSurface, /<iframe[\s\S]*?src=\{iframeSrc\}/)
  assert.match(previewSurface, /postMessage\(/)
})

test('sidebar chat rows expose delete actions without opening a session', () => {
  assert.match(sidebar, /onDeleteChat\?: \(chatId: string\) => void/)
  assert.match(sidebar, /const chatMenuFor = \(chat: ChatSessionSummary, active: boolean\)/)
  assert.match(sidebar, /onDelete: onDeleteChat\n\s*\? \(\) => onDeleteChat\(chat\.id\)/)
  assert.match(sidebar, /chatMenu=\{chatMenuFor\(chat, active\)\}/)
  assert.match(sidebar, /data-chat-actions/)
  assert.match(sidebar, /data-chat-status-orb/)
  assert.match(sidebar, /group-hover:opacity-0 group-focus-within:opacity-0/)
  assert.match(chat, /onDeleteChat=\{\(chatId\) => \{ void deleteChat\(chatId\) \}\}/)
  assert.match(chat, /const deleteChat = useCallback\(async \(targetSessionId: string\)/)
})
