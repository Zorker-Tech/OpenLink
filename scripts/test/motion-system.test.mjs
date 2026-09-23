import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const rootLayout = await readFile(new URL('../../app/layout.tsx', import.meta.url), 'utf8')
const motionProvider = await readFile(new URL('../../components/ui/motion-provider.tsx', import.meta.url), 'utf8')
const themeScope = await readFile(new URL('../../components/ui/theme-scope.tsx', import.meta.url), 'utf8')
const collapsible = await readFile(new URL('../../components/ui/collapsible.tsx', import.meta.url), 'utf8')
const reasoning = await readFile(new URL('../../components/ai-elements/reasoning.tsx', import.meta.url), 'utf8')
const globalStyles = await readFile(new URL('../../app/globals.css', import.meta.url), 'utf8')
const chatWorkspace = await readFile(new URL('../../components/chat-workspace.tsx', import.meta.url), 'utf8')

test('the app exposes one reduced-motion-aware motion boundary', () => {
  assert.match(rootLayout, /<OpenLinkMotionProvider>[\s\S]*<\/OpenLinkMotionProvider>/)
  assert.match(motionProvider, /<MotionConfig reducedMotion="user">/)
  // The root boundary must not animate the document: the persistent chrome
  // (sidebar, topbars) stayed fixed while the whole page faded and slid.
  assert.doesNotMatch(motionProvider, /AnimatePresence|usePathname/)
  assert.match(themeScope, /<MotionConfig reducedMotion="user">/)
})

test('route transitions are scoped to each shell content region', () => {
  const pageTransition = readFile(new URL('../../components/ui/page-transition.tsx', import.meta.url), 'utf8')
  return pageTransition.then((source) => {
    assert.match(source, /key=\{pathname\}/)
    assert.match(source, /animate=\{\{ opacity: 1, y: 0 \}\}/)
  })
})

test('global interaction feedback preserves reduced-motion users', () => {
  assert.match(globalStyles, /transition-property: color, background-color, border-color, box-shadow, opacity, transform, scale/)
  assert.match(globalStyles, /:active \{\n    scale: 0\.985;/)
  assert.match(globalStyles, /prefers-reduced-motion: reduce/)
  assert.match(globalStyles, /scale: 1 !important/)
})

test('workspace tabs animate insertion, removal, and reflow', () => {
  assert.match(chatWorkspace, /<AnimatePresence initial=\{false\} mode="popLayout">/)
  assert.match(chatWorkspace, /layout\n              transition=\{\{ duration: 0\.18/)
  assert.match(chatWorkspace, /exit=\{\{ opacity: 0, scale: 0\.96 \}\}/)
})

test('panel and protocol collapsibles keep their content mounted for authored transitions', () => {
  assert.match(collapsible, /className, keepMounted = true/)
  assert.match(collapsible, /className=\{cn\("openlink-collapsible-content", className\)\}/)
  assert.match(collapsible, /keepMounted=\{keepMounted\}/)
  assert.match(globalStyles, /\.openlink-collapsible-content\s*\{[\s\S]*transition-property: height, opacity/)
  assert.match(globalStyles, /\.openlink-collapsible-content\[data-starting-style\]/)
  assert.match(globalStyles, /#chat-workspace-panels\[data-panel-motion='active'\]/)
  assert.match(chatWorkspace, /data-panel-motion=\{panelMotionActive \? 'active' : 'idle'\}/)
  assert.match(chatWorkspace, /animate=\{\{ opacity: chatCollapsed \? 0 : 1, x: chatCollapsed \? -10 : 0 \}\}/)
})

test('reasoning triggers opt out of press scaling', () => {
  assert.match(reasoning, /<CollapsibleTrigger\n\s*data-no-press-motion/)
  assert.match(globalStyles, /:not\(\[data-no-press-motion\]\):active/)
})
