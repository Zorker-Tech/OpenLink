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
  assert.match(workspace, /aria-label="会话状态"/)
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
  assert.match(workspace, /aria-label="退出 Plan 模式".*runControl\('default'\)/)
  assert.match(workspace, /aria-label="清除 Goal".*runControl\('goal-clear'\)/)
  assert.match(workspace, /disabled=\{controlPending \|\| status === 'streaming'\}/)
})

test('permission changes are blocked during turns and report only verified runtime state', () => {
  const menu = readFileSync(new URL('../../components/prompt-add-menu.tsx', import.meta.url), 'utf8')
  assert.match(workspace, /accessModeChangeDisabled=\{controlPending \|\| status === 'streaming'\}/)
  assert.match(workspace, /transitionAccessMode\(\{ currentMode: accessMode, nextMode: mode/)
  assert.match(workspace, /权限切换未生效，已恢复原权限/)
  assert.match(menu, /disabled=\{accessModeChangeDisabled \|\| permissions === mode\}/)
})

test('runtime lease does not reuse an unmounted browser workbench session', () => {
  assert.match(workspace, /\(workspaceView === 'browser' \|\| workspaceView === 'mobile'\) && browserState\.browserSessionId/)
  assert.match(workspace, /\[accessMode, agentStreamStatus, browserState\.browserSessionId, sessionId, workspaceView\]/)
})
