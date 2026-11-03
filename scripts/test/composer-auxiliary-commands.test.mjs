import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const workspace = readFileSync(new URL('../../components/chat-workspace.tsx', import.meta.url), 'utf8')

test('rename is an empty-composer client action backed by the existing title editor', () => {
  assert.match(workspace, /label: '\/rename'.*action: 'rename'.*requiresEmptyComposer: true/)
  assert.match(workspace, /\/\^\\\/rename\\s\*\$\/i\.test\(text\).*onRename\(\)/)
  assert.match(workspace, /onRename=\{\(\) => setRenameRequestVersion/)
})

test('status opens a local status surface and refreshes native runtime state', () => {
  assert.match(workspace, /label: '\/status'.*action: 'status-panel'/)
  assert.match(workspace, /aria-label=\{t\('会话状态'\)\}/)
  assert.match(workspace, /setStatusPanelOpen\(true\); void runControl\('status'\)/)
  assert.match(workspace, /当前 Provider 未提供/)
})

test('client actions do not fall through to prompt submission', () => {
  assert.match(workspace, /if \(action === 'rename'\) \{ onRename\(\); return \}/)
  assert.match(workspace, /if \(action === 'status-panel'\).*return \}/)
})

test('fork is an idle-only native client action that navigates to its new chat', () => {
  assert.match(workspace, /label: '\/fork'.*action: 'fork'.*requiresEmptyComposer: true.*disabled:/)
  assert.match(workspace, /action === 'fork'.*payload\?\.fork\?\.path.*onFork\(payload\.fork\.path\)/)
  assert.match(workspace, /\^\\\/fork\\s\*\$\/i\.test\(text\)[\s\S]*status === 'streaming'[\s\S]*请等待当前回复结束后再创建分支[\s\S]*runControl\('fork'\)/)
})

test('manual Review commands cannot bypass the running-state native command guard', () => {
  assert.match(workspace, /status === 'streaming'.*\^\\\/review\(\?:\\s\|\$\)\/i\.test\(cleanText\)[\s\S]*请等待当前回复结束后再开始 Review/)
})

test('manual native controls share the same running-state allowlist as command candidates', () => {
  assert.match(workspace, /CONTROL_ACTIONS_ALLOWED_DURING_TURN = new Set\(\['interrupt', 'pause', 'steer'\]\)/)
  assert.match(workspace, /status === 'streaming'.*submittedControl.*!CONTROL_ACTIONS_ALLOWED_DURING_TURN\.has[\s\S]*请等待当前回复结束后再执行/)
  assert.match(workspace, /disabled: !controlReady \|\| controlPending \|\| \(status === 'streaming' && !CONTROL_ACTIONS_ALLOWED_DURING_TURN\.has\(name\)\)/)
})

test('Plan and Goal footer indicators execute their native inverse actions', () => {
  assert.match(workspace, /aria-label=\{t\("退出 Plan 模式"\)\}.*runControl\("default"\)/)
  assert.match(workspace, /aria-label=\{t\("清除 Goal"\)\}.*runControl\("goal-clear"\)/)
  assert.match(workspace, /disabled=\{controlPending \|\| status === "streaming"\}/)
})

test('permission changes are blocked during turns and report only verified runtime state', () => {
  const menu = readFileSync(new URL('../../components/prompt-add-menu.tsx', import.meta.url), 'utf8')
  assert.match(workspace, /accessModeChangeDisabled=\{controlPending \|\| status === 'streaming'\}/)
  assert.match(workspace, /transitionAccessMode\(\{ currentMode: accessMode, nextMode: mode/)
  assert.match(workspace, /权限切换未生效，已恢复原权限/)
  assert.match(menu, /disabled=\{accessModeChangeDisabled \|\| permissions === mode\}/)
})

test('the Agent owns the Live Browser session instead of binding a transient preview', () => {
  // Agent Host creates a stable Chromium session for every Agent runtime. The
  // UI must not rebind that capability to its own native-preview session or
  // release it when the workbench unmounts.
  assert.doesNotMatch(workspace, /browserSessionId: browserState\.browserSessionId/)
  assert.doesNotMatch(workspace, /deleteBrowserSession\(chatSessionId, current\.state\.id\)/)
  const workbench = readFileSync(new URL('../../components/browser/browser-workbench.tsx', import.meta.url), 'utf8')
  assert.match(workbench, /previous\?\.state\.surface === 'native-preview'/)
  assert.match(workbench, /listBrowserPreviewTargets\(chatSessionId\)/)
  assert.match(workbench, /selectPreviewTarget/)
})

test('the prompt add menu is a runtime capability inventory, not a static menu', () => {
  const menu = readFileSync(new URL('../../components/prompt-add-menu.tsx', import.meta.url), 'utf8')
  const workspace = readFileSync(new URL('../../components/chat-workspace.tsx', import.meta.url), 'utf8')
  const route = readFileSync(new URL('../../app/api/chat/[session_id]/runtime-resources/route.ts', import.meta.url), 'utf8')
  assert.match(menu, /runtimeResources\?\.permissionProfiles/)
  assert.match(menu, /runtimeResources\?\.instructions/)
  assert.match(menu, /server\.status === 'connected'/)
  assert.match(menu, /server\.auth === 'required'/)
  assert.match(menu, /runtimeResources\?\.skills/)
  assert.match(route, /permissionProfiles/)
  assert.match(route, /instructions/)
  assert.match(route, /toolCount/)
  assert.match(workspace, /正在使用 Computer/)
  assert.match(workspace, /activeFlow\?\.activity/)
})

test('the Live Browser MCP surface covers launch, pages and full interaction', () => {
  const browserMcp = readFileSync(new URL('../../services/agent-worker/src/browser-mcp.ts', import.meta.url), 'utf8')
  const piExtension = readFileSync(new URL('../../services/agent-browser-extension/openlink-browser.ts', import.meta.url), 'utf8')
  for (const tool of ['browser_pages', 'browser_open', 'browser_close', 'browser_activate', 'browser_navigate', 'browser_back', 'browser_forward', 'browser_reload', 'browser_click', 'browser_hover', 'browser_type', 'browser_insert_text', 'browser_drag', 'browser_key', 'browser_scroll', 'browser_screenshot', 'browser_dialog']) {
    assert.match(browserMcp, new RegExp(`name: '${tool}'`))
  }
  for (const tool of ['browser_pages', 'browser_open', 'browser_close', 'browser_activate', 'browser_history', 'browser_insert_text']) {
    assert.match(piExtension, new RegExp(`name: '${tool}'`))
  }
})
