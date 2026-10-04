import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test, { after } from 'node:test'
import React, { act } from 'react'
import * as jsx from 'react/jsx-runtime'
import { JSDOM } from 'jsdom'
import ts from 'typescript'

// DOM-only component tests; no live browser, services, credentials or network.
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://openlink.example' })
const saved = new Map()
for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) {
  saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
}
after(() => { dom.window.close(); for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key] } })
const { createRoot } = await import('react-dom/client')
const passthrough = ({ children }) => children
const modules = {
  react: React,
  'react/jsx-runtime': jsx,
  'next/link': { default: ({ children, ...props }) => React.createElement('a', props, children) },
  '@/lib/i18n/client': { useT: () => (text) => text },
  '@/components/ui/dropdown-menu': {
    DropdownMenu: passthrough, DropdownMenuContent: passthrough,
    DropdownMenuItem: ({ children, render, disabled }) => render ? React.cloneElement(render, {}, children) : React.createElement('button', { disabled }, children),
    DropdownMenuTrigger: ({ children, render }) => React.cloneElement(render, {}, children),
  },
}
function load(path) {
  const code = ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const exports = {}
  new Function('require', 'exports', code)((name) => { assert.ok(name in modules, name); return modules[name] }, exports)
  return exports
}
const { WorkspaceNavigation } = load('../../components/workspace-navigation.tsx')
const { useSidebarCollapsed } = load('../../lib/use-sidebar-collapsed.ts')
async function mount({ desktop = true, collapsed = true, mobileOpen = false, persistent = false } = {}) {
  window.matchMedia = () => ({ matches: desktop, addEventListener() {}, removeEventListener() {} })
  let searches = 0
  function Fixture() {
    const local = React.useState(collapsed)
    const stored = useSidebarCollapsed()
    const [closed, setClosed] = persistent ? stored : local
    const [mobile, setMobile] = React.useState(mobileOpen)
    return React.createElement(WorkspaceNavigation, { activePage: '项目', collapsed: closed, mobileOpen: mobile, onCloseMobile: () => setMobile(false), onToggle: () => setClosed((value) => !value), onHistory: () => searches++, workspaceSlug: 'example', footer: null },
      React.createElement('button', { onClick: () => desktop ? setClosed((value) => !value) : setMobile(false), 'data-collapse': '' }, '收起'),
      React.createElement('input', { 'aria-label': 'composer' }))
  }
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  await act(async () => root.render(React.createElement(Fixture)))
  return { container, get searches() { return searches }, panel: () => container.querySelector('aside'), close: async () => { await act(async () => root.unmount()); container.remove() } }
}
const hover = (node) => node.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }))
const key = (node, key, extra = {}) => node.dispatchEvent(new window.KeyboardEvent('keydown', { bubbles: true, key, ...extra }))

test('rail destinations survive collapse and history has a working action', async () => {
  const h = await mount()
  try {
    assert.equal(h.panel().hasAttribute('inert'), true)
    assert.equal(h.container.querySelector('[aria-label="项目"]').getAttribute('href'), '/app/example/projects')
    assert.equal(h.container.querySelector('[aria-label="项目"]').getAttribute('aria-current'), 'page')
    assert.equal(h.container.querySelector('[aria-label="知识库"]').getAttribute('href'), '/app/example/knowledge')
    await act(async () => h.container.querySelector('[aria-label="搜索聊天"]').click())
    assert.equal(h.searches, 1)
  } finally { await h.close() }
})
test('hover previews without pinning; Escape dismisses and returns focus', async () => {
  const h = await mount()
  try {
    const trigger = h.container.querySelector('[aria-label="展开侧边栏"]')
    await act(async () => hover(trigger))
    assert.equal(h.panel().dataset.preview, 'true')
    assert.equal(h.panel().dataset.collapsed, 'true')
    assert.equal(h.panel().hasAttribute('inert'), false)
    await act(async () => { h.panel().querySelector('button').focus(); key(window, 'Escape') })
    assert.equal(h.panel().dataset.preview, 'false')
    assert.equal(h.panel().hasAttribute('inert'), true)
    assert.equal(document.activeElement, trigger)
  } finally { await h.close() }
})
test('pinning then collapsing clears transient preview and hidden focus', async () => {
  const h = await mount()
  try {
    const trigger = h.container.querySelector('[aria-label="展开侧边栏"]')
    await act(async () => { hover(trigger); trigger.click() })
    assert.equal(h.panel().dataset.collapsed, 'false')
    assert.equal(h.panel().dataset.preview, 'false')
    await act(async () => { const close = h.panel().querySelector('button'); close.focus(); close.click() })
    assert.equal(h.panel().hasAttribute('inert'), true)
    assert.equal(document.activeElement.getAttribute('aria-label'), '展开侧边栏')
  } finally { await h.close() }
})
test('desktop shortcut toggles the panel but does not intercept composer editing', async () => {
  const h = await mount({ collapsed: false })
  try {
    await act(async () => key(h.panel().querySelector('input'), 'b', { metaKey: true }))
    assert.equal(h.panel().dataset.collapsed, 'false')
    await act(async () => key(window, 'b', { ctrlKey: true }))
    assert.equal(h.panel().dataset.collapsed, 'true')
  } finally { await h.close() }
})
test('desktop chat sidebar exposes an adjustable separator and persists keyboard sizing', async () => {
  window.localStorage.removeItem('openlink-chat-sidebar-width')
  const h = await mount({ collapsed: false })
  try {
    const separator = h.container.querySelector('[role="separator"]')
    assert.ok(separator)
    assert.equal(separator.getAttribute('aria-orientation'), 'vertical')
    assert.equal(separator.getAttribute('aria-valuemin'), '240')
    assert.equal(separator.getAttribute('aria-valuemax'), '420')
    assert.equal(separator.getAttribute('aria-valuenow'), '288')
    await act(async () => key(separator, 'ArrowRight'))
    assert.equal(separator.getAttribute('aria-valuenow'), '292')
    assert.equal(h.container.querySelector('.workspace-sidebar-slot').style.getPropertyValue('--workspace-sidebar-width'), '292px')
    assert.equal(window.localStorage.getItem('openlink-chat-sidebar-width'), '292')
    await act(async () => key(separator, 'Home'))
    assert.equal(separator.getAttribute('aria-valuenow'), '240')
    await act(async () => key(separator, 'End'))
    assert.equal(separator.getAttribute('aria-valuenow'), '420')
  } finally { await h.close(); window.localStorage.removeItem('openlink-chat-sidebar-width') }
})
test('mobile drawer closes with Escape and removes its controls from focus', async () => {
  const h = await mount({ desktop: false, collapsed: false, mobileOpen: true })
  try {
    assert.equal(h.panel().hasAttribute('inert'), false)
    const first = h.panel().querySelector('button')
    const last = h.panel().querySelector('input')
    assert.equal(document.activeElement, first)
    await act(async () => key(first, 'Tab', { shiftKey: true }))
    assert.equal(document.activeElement, last)
    await act(async () => key(last, 'Tab'))
    assert.equal(document.activeElement, first)
    await act(async () => key(window, 'Escape'))
    assert.equal(h.panel().dataset.mobileOpen, 'false')
    assert.equal(h.panel().hasAttribute('inert'), true)
  } finally { await h.close() }
})
test('pinned state survives a workspace surface remount', async () => {
  window.localStorage.setItem('openlink-sidebar-collapsed', '1')
  const first = await mount({ persistent: true })
  await act(async () => first.container.querySelector('[aria-label="展开侧边栏"]').click())
  assert.equal(window.localStorage.getItem('openlink-sidebar-collapsed'), '0')
  await first.close()
  const second = await mount({ persistent: true })
  try { assert.equal(second.panel().dataset.collapsed, 'false') } finally { await second.close(); window.localStorage.clear() }
})
