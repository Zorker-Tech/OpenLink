import { Type } from '@earendil-works/pi-ai'
import { defineTool, type ExtensionAPI } from '@earendil-works/pi-coding-agent'

function required(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required by the OpenLink browser extension`)
  return value
}

const hostUrl = required('OPENLINK_BROWSER_HOST_URL').replace(/\/$/, '')
const sessionId = required('OPENLINK_BROWSER_SESSION_ID')
let controlToken = required('OPENLINK_BROWSER_CONTROL_TOKEN')
let controlTokenIssuedAt = Date.now()

async function refreshControlToken(signal?: AbortSignal): Promise<void> {
  const response = await fetch(`${hostUrl}/v1/browser/sessions/${encodeURIComponent(sessionId)}/capability`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${controlToken}`, 'Content-Type': 'application/json' },
    signal,
  })
  const payload = await response.json() as { controlToken?: unknown }
  if (!response.ok || typeof payload.controlToken !== 'string' || !payload.controlToken) {
    throw new Error(`Browser capability refresh failed (${response.status})`)
  }
  controlToken = payload.controlToken
  controlTokenIssuedAt = Date.now()
}

async function invoke(action: Record<string, unknown>, signal?: AbortSignal) {
  if (Date.now() - controlTokenIssuedAt >= 5 * 60_000) await refreshControlToken(signal)
  const actionId = crypto.randomUUID()
  let response = await fetch(`${hostUrl}/v1/browser/sessions/${encodeURIComponent(sessionId)}/actions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${controlToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ version: 1, actionId, sessionId, actor: 'agent', action }),
    signal,
  })
  if (response.status === 401) {
    await refreshControlToken(signal)
    response = await fetch(`${hostUrl}/v1/browser/sessions/${encodeURIComponent(sessionId)}/actions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${controlToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: 1, actionId, sessionId, actor: 'agent', action }),
      signal,
    })
  }
  const payload = await response.json() as { result?: { ok: boolean; error?: { message?: string }; [key: string]: unknown }; error?: { message?: string } }
  if (!response.ok || !payload.result) throw new Error(payload.error?.message ?? `Browser Host returned ${response.status}`)
  if (!payload.result.ok) throw new Error(payload.result.error?.message ?? 'Browser action failed')
  return payload.result
}

function textResult(result: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], details: result }
}

/** OpenLink's scoped Browser Host tools. The capability is injected per Pi session. */
export default function openLinkBrowserExtension(pi: ExtensionAPI) {
  pi.registerTool(defineTool({
    name: 'browser_open', label: 'Open browser page',
    description: 'Open a URL in the shared OpenLink browser. Returns a page id for subsequent browser tools.',
    promptSnippet: 'Open and interact with pages in the shared OpenLink browser.',
    parameters: Type.Object({ url: Type.String({ description: 'Absolute URL to open' }) }),
    async execute(_id, params, signal) { return textResult(await invoke({ type: 'page.open', url: params.url }, signal)) },
  }))
  pi.registerTool(defineTool({
    name: 'browser_read', label: 'Read browser page', description: 'Read the structured accessibility and DOM snapshot. Prefer this before coordinate actions.',
    parameters: Type.Object({ pageId: Type.String() }),
    async execute(_id, params, signal) {
      const result = await invoke({ type: 'page.read', pageId: params.pageId }, signal)
      return { content: [{ type: 'text' as const, text: String(result.snapshot ?? '{}') }], details: result }
    },
  }))
  pi.registerTool(defineTool({
    name: 'browser_navigate', label: 'Navigate browser page', description: 'Navigate an existing page to an absolute URL.',
    parameters: Type.Object({ pageId: Type.String(), url: Type.String() }),
    async execute(_id, params, signal) { return textResult(await invoke({ type: 'page.navigate', ...params }, signal)) },
  }))
  pi.registerTool(defineTool({
    name: 'browser_click', label: 'Click browser element', description: 'Click using a browser_read ref, CSS selector, or viewport point.',
    parameters: Type.Object({
      pageId: Type.String(), ref: Type.Optional(Type.String()), selector: Type.Optional(Type.String()),
      x: Type.Optional(Type.Number()), y: Type.Optional(Type.Number()),
      button: Type.Optional(Type.Union([Type.Literal('left'), Type.Literal('middle'), Type.Literal('right')])),
    }),
    async execute(_id, params, signal) { return textResult(await invoke({ type: 'element.click', ...params }, signal)) },
  }))
  pi.registerTool(defineTool({
    name: 'browser_type', label: 'Type in browser element', description: 'Replace an editable element value and optionally submit it.',
    parameters: Type.Object({ pageId: Type.String(), ref: Type.Optional(Type.String()), selector: Type.Optional(Type.String()), text: Type.String(), submit: Type.Optional(Type.Boolean()) }),
    async execute(_id, params, signal) { return textResult(await invoke({ type: 'element.type', ...params }, signal)) },
  }))
  pi.registerTool(defineTool({
    name: 'browser_hover', label: 'Hover browser element', description: 'Hover using a ref, selector, or viewport point.',
    parameters: Type.Object({ pageId: Type.String(), ref: Type.Optional(Type.String()), selector: Type.Optional(Type.String()), x: Type.Optional(Type.Number()), y: Type.Optional(Type.Number()) }),
    async execute(_id, params, signal) { return textResult(await invoke({ type: 'element.hover', ...params }, signal)) },
  }))
  pi.registerTool(defineTool({
    name: 'browser_drag', label: 'Drag browser element', description: 'Drag from one viewport point to another.',
    parameters: Type.Object({ pageId: Type.String(), fromX: Type.Number(), fromY: Type.Number(), toX: Type.Number(), toY: Type.Number() }),
    async execute(_id, params, signal) {
      return textResult(await invoke({ type: 'element.drag', pageId: params.pageId, from: { x: params.fromX, y: params.fromY }, to: { x: params.toX, y: params.toY } }, signal))
    },
  }))
  pi.registerTool(defineTool({
    name: 'browser_key', label: 'Press browser key', description: 'Press a keyboard key or shortcut in the active element.',
    parameters: Type.Object({ pageId: Type.String(), key: Type.String(), modifiers: Type.Optional(Type.Array(Type.String())) }),
    async execute(_id, params, signal) { return textResult(await invoke({ type: 'keyboard.key', ...params }, signal)) },
  }))
  pi.registerTool(defineTool({
    name: 'browser_scroll', label: 'Scroll browser page', description: 'Scroll the page at a viewport point.',
    parameters: Type.Object({ pageId: Type.String(), x: Type.Number(), y: Type.Number(), deltaX: Type.Number(), deltaY: Type.Number() }),
    async execute(_id, params, signal) { return textResult(await invoke({ type: 'wheel', ...params }, signal)) },
  }))
  pi.registerTool(defineTool({
    name: 'browser_screenshot', label: 'Screenshot browser page', description: 'Capture a viewport or full-page screenshot for visual verification.',
    parameters: Type.Object({ pageId: Type.String(), fullPage: Type.Optional(Type.Boolean()) }),
    async execute(_id, params, signal) {
      const result = await invoke({ type: 'page.screenshot', ...params }, signal)
      const image = result.image as { mimeType?: string; data?: string } | undefined
      if (!image?.mimeType || !image.data) throw new Error('Browser Host returned no screenshot')
      return { content: [{ type: 'image' as const, mimeType: image.mimeType, data: image.data }], details: { pageId: params.pageId, fullPage: params.fullPage ?? false } }
    },
  }))
  pi.registerTool(defineTool({
    name: 'browser_dialog', label: 'Handle browser dialog', description: 'Accept or dismiss the pending alert, confirmation, or prompt.',
    parameters: Type.Object({ pageId: Type.String(), accept: Type.Boolean(), promptText: Type.Optional(Type.String()) }),
    async execute(_id, params, signal) { return textResult(await invoke({ type: 'dialog.handle', ...params }, signal)) },
  }))
}
