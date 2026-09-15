import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = await readFile(new URL('../../components/chat-workspace.tsx', import.meta.url), 'utf8')
const sidebar = await readFile(new URL('../../components/app-workspace.tsx', import.meta.url), 'utf8')

test('workspace modes use persistent labeled tabs and a new-tab menu', () => {
  assert.match(source, /type WorkspaceTabId = 'preview' \| 'realtime' \| 'code' \| 'database'/)
  assert.match(source, /aria-label="工作区标签"/)
  assert.match(source, /role="tab"/)
  assert.match(source, /label="打开新标签"/)
  assert.match(source, /aria-label={`关闭\$\{tab\.label\}标签`}/)
  assert.match(source, /const closeWorkspaceTab = useCallback\(\(tabId: WorkspaceTabId\)/)
  assert.match(source, /current\.includes\(tab\) \? current : \[\.\.\.current, tab\]/)
  assert.match(source, /side: 'chat' \| 'workspace'/)
  assert.match(source, /data-header-region="chat-title"/)
  assert.match(source, /data-header-region="workspace-tabs"/)
  assert.match(source, /const \[openWorkspaceTabs, setOpenWorkspaceTabs\] = useState<WorkspaceTabId\[\]>\(\['preview'\]\)/)
  assert.match(source, /const workspaceTabsOpen = openWorkspaceTabs\.length > 0/)
  assert.doesNotMatch(source, /chatPanelWidth|--chat-panel-width|setChatPanelWidth/)
  for (const label of ['预览', '实时浏览器', '代码', '数据库']) assert.match(source, new RegExp(`label: '${label}'`))
})

test('collapsing the timeline also collapses its matching title region', () => {
  const topbar = source.slice(source.indexOf('function ChatTopbar('), source.indexOf('function BrowserNavigationBar('))

  assert.match(topbar, /<motion\.div/)
  assert.match(topbar, /animate=\{\{ opacity: chatCollapsed \? 0 : 1, x: chatCollapsed \? -10 : 0 \}\}/)
  assert.match(topbar, /aria-hidden=\{chatCollapsed\}/)
  assert.match(topbar, /data-header-region="chat-title"/)
  assert.match(topbar, /<motion\.span[\s\S]*key=\{sessionTitle\}[\s\S]*transition=\{\{ duration: 0\.18/)
  assert.match(topbar, /chatCollapsed && collapsed && <ToolbarButton label="展开侧边栏"/)
})

test('closing the final workspace tab switches the desktop surface to chat-only', () => {
  assert.match(source, /setOpenWorkspaceTabs\(remaining\)/)
  assert.match(source, /if \(remaining\.length === 0\)/)
  assert.match(source, /setBrowserState\(\(current\) => current\.surface === 'native-preview'/)
  assert.match(source, /data-workspace-layout=\{workspaceTabsOpen \? 'split' : 'chat-only'\}/)
  assert.match(source, /<AnimatePresence initial=\{false\} mode="popLayout">/)
  assert.match(source, /key="workspace-split"/)
  assert.match(source, /key="chat-only"/)
  assert.match(source, /data-chat-panel="full"/)
  assert.match(source, /<ChatTopbar \{\.\.\.chatTopbarProps\} side="chat" \/>/)
  assert.match(source, /<ChatTopbar \{\.\.\.chatTopbarProps\} side="workspace" \/>/)
  assert.match(source, /<ResizablePanelGroup className="min-h-0"[\s\S]*<ChatTopbar \{\.\.\.chatTopbarProps\} side="chat"[\s\S]*<ChatTopbar \{\.\.\.chatTopbarProps\} side="workspace"/)
  assert.match(source, /data-chat-panel="full"/)
  assert.match(source, /w-full max-w-3xl flex-1 flex-col/)
  assert.match(source, /initialSurface=\{browserState\.surface\}/)
})

test('browser navigation lives in a dedicated preview-canvas toolbar', () => {
  const topbar = source.slice(source.indexOf('function ChatTopbar('), source.indexOf('function BrowserNavigationBar('))
  const navigation = source.slice(source.indexOf('function BrowserNavigationBar('), source.indexOf('function ComposerAttachments('))
  const preview = source.slice(source.indexOf('function PreviewCanvas('), source.indexOf('export function ChatWorkspace('))

  assert.doesNotMatch(topbar, /aria-label="浏览器地址"/)
  assert.match(navigation, /aria-label="浏览器工具栏"/)
  assert.match(navigation, /className="flex h-11 shrink-0/)
  assert.match(navigation, /max-w-\[500px\]/)
  assert.match(preview, /<BrowserNavigationBar /)
})

test('sidebar chat rows expose delete actions without opening a session', () => {
  assert.match(sidebar, /onDeleteChat\?: \(chatId: string\) => void/)
  assert.match(sidebar, /const chatMenuFor = \(chat: ChatSessionSummary, active: boolean\)/)
  assert.match(sidebar, /onDelete: onDeleteChat\n\s*\? \(\) => onDeleteChat\(chat\.id\)/)
  assert.match(sidebar, /chatMenu=\{chatMenuFor\(chat, active\)\}/)
  assert.match(sidebar, /data-chat-actions/)
  assert.match(sidebar, /data-chat-status-orb/)
  assert.match(sidebar, /group-hover:opacity-0 group-focus-within:opacity-0/)
  assert.match(source, /onDeleteChat=\{\(chatId\) => \{ void deleteChat\(chatId\) \}\}/)
  assert.match(source, /const deleteChat = useCallback\(async \(targetSessionId: string\)/)
})
