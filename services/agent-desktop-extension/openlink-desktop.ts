import { Type } from '@earendil-works/pi-ai'
import { defineTool, type ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { request as httpRequest } from 'node:http'

const socketPath = process.env.OPENLINK_DESKTOP_TOOL_SOCKET || '/run/user/1000/openlink-desktop-tool.sock'

interface BridgeResult {
  exitCode: number
  stdout: string
  stderr?: string
}

function invoke(argv: string[], signal?: AbortSignal): Promise<BridgeResult> {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify({ argv }))
    const request = httpRequest({
      socketPath,
      path: '/run',
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': payload.length },
      timeout: 125_000,
    }, (response) => {
      const chunks: Buffer[] = []
      let size = 0
      response.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > 32_000_000) {
          request.destroy(new Error('Desktop bridge response is too large'))
          return
        }
        chunks.push(chunk)
      })
      response.on('end', () => {
        if (response.statusCode !== 200) {
          reject(new Error(`Desktop bridge returned HTTP ${response.statusCode}`))
          return
        }
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as BridgeResult
          resolve({ exitCode: Number.isInteger(value.exitCode) ? value.exitCode : 1, stdout: String(value.stdout ?? ''), stderr: value.stderr })
        } catch {
          reject(new Error('Desktop bridge returned invalid JSON'))
        }
      })
    })
    request.once('error', reject)
    request.once('timeout', () => request.destroy(new Error('Desktop bridge timed out')))
    if (signal) {
      const abort = () => request.destroy(new Error('Desktop request was canceled'))
      if (signal.aborted) abort()
      else signal.addEventListener('abort', abort, { once: true })
    }
    request.end(payload)
  })
}

async function execute(argv: string[], signal?: AbortSignal): Promise<Record<string, unknown>> {
  const bridge = await invoke(argv, signal)
  let envelope: Record<string, unknown>
  try {
    envelope = JSON.parse(bridge.stdout) as Record<string, unknown>
  } catch {
    throw new Error(bridge.stderr || bridge.stdout || 'Desktop command returned no output')
  }
  if (bridge.exitCode !== 0 || envelope.ok !== true) {
    const error = envelope.error && typeof envelope.error === 'object' ? envelope.error as Record<string, unknown> : {}
    throw new Error(typeof error.message === 'string' ? error.message : 'Desktop command failed')
  }
  return envelope
}

function textResult(envelope: Record<string, unknown>) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(envelope) }], details: envelope }
}

function target(app?: string, windowId?: string): string[] {
  const output: string[] = []
  if (app) output.push('--app', app)
  if (windowId) output.push('--window-id', windowId)
  return output
}

/** Pi-native desktop tools. They share the Project VM bridge with the
 * agent-desktop CLI, so Pi, Codex MCP, and shell all enforce the same policy. */
export default function openLinkDesktopExtension(pi: ExtensionAPI) {
  pi.registerTool(defineTool({
    name: 'desktop_status',
    label: 'Desktop status',
    description: 'Report desktop automation health, permissions, supported surfaces, and version.',
    promptSnippet: 'Inspect and operate the project Ubuntu desktop through accessibility.',
    parameters: Type.Object({}),
    async execute(_id, _params, signal) { return textResult(await execute(['status'], signal)) },
  }))
  pi.registerTool(defineTool({
    name: 'desktop_list_apps',
    label: 'List desktop apps',
    description: 'List running applications on the project desktop.',
    parameters: Type.Object({ app: Type.Optional(Type.String()) }),
    async execute(_id, params, signal) {
      return textResult(await execute(['list-apps', ...(params.app ? ['--app', params.app] : [])], signal))
    },
  }))
  pi.registerTool(defineTool({
    name: 'desktop_snapshot',
    label: 'Snapshot desktop',
    description: 'Capture the accessibility tree with stable refs. Observe before acting and again after UI changes.',
    parameters: Type.Object({
      app: Type.Optional(Type.String()),
      windowId: Type.Optional(Type.String()),
      surface: Type.Optional(Type.String()),
      root: Type.Optional(Type.String()),
      interactiveOnly: Type.Optional(Type.Boolean()),
      compact: Type.Optional(Type.Boolean()),
      skeleton: Type.Optional(Type.Boolean()),
      includeBounds: Type.Optional(Type.Boolean()),
      maxDepth: Type.Optional(Type.Number()),
      timeoutMs: Type.Optional(Type.Number()),
    }),
    async execute(_id, params, signal) {
      const argv = ['snapshot', ...target(params.app, params.windowId)]
      if (params.surface) argv.push('--surface', params.surface)
      if (params.root) argv.push('--root', params.root)
      if (params.interactiveOnly !== false) argv.push('-i')
      if (params.compact !== false) argv.push('--compact')
      if (params.skeleton) argv.push('--skeleton')
      if (params.includeBounds) argv.push('--include-bounds')
      if (params.maxDepth) argv.push('--max-depth', String(Math.trunc(params.maxDepth)))
      if (params.timeoutMs) argv.push('--timeout-ms', String(Math.trunc(params.timeoutMs)))
      return textResult(await execute(argv, signal))
    },
  }))
  pi.registerTool(defineTool({
    name: 'desktop_find',
    label: 'Find desktop element',
    description: 'Find an element by role, name, text, value, or root ref before taking a full snapshot.',
    parameters: Type.Object({
      app: Type.Optional(Type.String()),
      windowId: Type.Optional(Type.String()),
      surface: Type.Optional(Type.String()),
      root: Type.Optional(Type.String()),
      role: Type.Optional(Type.String()),
      name: Type.Optional(Type.String()),
      text: Type.Optional(Type.String()),
      value: Type.Optional(Type.String()),
      exact: Type.Optional(Type.Boolean()),
      first: Type.Optional(Type.Boolean()),
      count: Type.Optional(Type.Boolean()),
      limit: Type.Optional(Type.Number()),
      timeoutMs: Type.Optional(Type.Number()),
    }),
    async execute(_id, params, signal) {
      const argv = ['find', ...target(params.app, params.windowId)]
      if (params.surface) argv.push('--surface', params.surface)
      if (params.root) argv.push('--root', params.root)
      for (const key of ['role', 'name', 'text', 'value'] as const) {
        if (params[key]) argv.push(`--${key}`, params[key]!)
      }
      if (params.exact) argv.push('--exact')
      if (params.first) argv.push('--first')
      if (params.count) argv.push('--count')
      if (params.limit) argv.push('--limit', String(Math.trunc(params.limit)))
      if (params.timeoutMs) argv.push('--timeout-ms', String(Math.trunc(params.timeoutMs)))
      return textResult(await execute(argv, signal))
    },
  }))
  pi.registerTool(defineTool({
    name: 'desktop_click',
    label: 'Click desktop element',
    description: 'Activate an element by its snapshot ref. Snapshot again after the UI changes.',
    parameters: Type.Object({ ref: Type.String(), headed: Type.Optional(Type.Boolean()) }),
    async execute(_id, params, signal) {
      return textResult(await execute([...(params.headed ? ['--headed'] : []), 'click', params.ref], signal))
    },
  }))
  pi.registerTool(defineTool({
    name: 'desktop_type',
    label: 'Type in desktop element',
    description: 'Type into a snapshot ref, or set its value. Re-read the field before retrying an uncertain write.',
    parameters: Type.Object({
      ref: Type.String(), text: Type.String(), headed: Type.Optional(Type.Boolean()),
      intervalMs: Type.Optional(Type.Number()), timeoutMs: Type.Optional(Type.Number()),
    }),
    async execute(_id, params, signal) {
      const argv = [...(params.headed ? ['--headed'] : []), 'type', params.ref, params.text]
      if (params.intervalMs) argv.push('--interval-ms', String(Math.trunc(params.intervalMs)))
      if (params.timeoutMs) argv.push('--timeout-ms', String(Math.trunc(params.timeoutMs)))
      return textResult(await execute(argv, signal))
    },
  }))
  pi.registerTool(defineTool({
    name: 'desktop_press',
    label: 'Press desktop key',
    description: 'Send a keyboard shortcut or key to an application or the foreground window.',
    parameters: Type.Object({
      key: Type.String(), app: Type.Optional(Type.String()), windowId: Type.Optional(Type.String()), headed: Type.Optional(Type.Boolean()),
    }),
    async execute(_id, params, signal) {
      return textResult(await execute([...(params.headed ? ['--headed'] : []), 'press', params.key, ...target(params.app, params.windowId)], signal))
    },
  }))
  pi.registerTool(defineTool({
    name: 'desktop_launch',
    label: 'Launch desktop app',
    description: 'Launch a native application and optionally wait for its window and activate it.',
    parameters: Type.Object({
      app: Type.String(), args: Type.Optional(Type.Array(Type.String())), activate: Type.Optional(Type.Boolean()),
      headed: Type.Optional(Type.Boolean()), timeoutMs: Type.Optional(Type.Number()),
    }),
    async execute(_id, params, signal) {
      const argv = [...(params.headed ? ['--headed'] : []), 'launch', params.app]
      for (const arg of params.args ?? []) argv.push('--arg', arg)
      if (params.activate) argv.push('--activate')
      if (params.timeoutMs) argv.push('--timeout', String(Math.trunc(params.timeoutMs)))
      return textResult(await execute(argv, signal))
    },
  }))
  pi.registerTool(defineTool({
    name: 'desktop_screenshot',
    label: 'Screenshot desktop',
    description: 'Capture the desktop, an app, or a window for visual verification.',
    parameters: Type.Object({ app: Type.Optional(Type.String()), windowId: Type.Optional(Type.String()), screen: Type.Optional(Type.Number()) }),
    async execute(_id, params, signal) {
      const argv = ['screenshot', ...target(params.app, params.windowId)]
      if (params.screen !== undefined) argv.push('--screen', String(Math.trunc(params.screen)))
      const envelope = await execute(argv, signal)
      const data = envelope.data && typeof envelope.data === 'object' ? envelope.data as Record<string, unknown> : {}
      if (typeof data.data !== 'string' || data.format !== 'png') throw new Error('Desktop returned no screenshot')
      return { content: [{ type: 'image' as const, mimeType: 'image/png', data: data.data }], details: { app: params.app, windowId: params.windowId, screen: params.screen } }
    },
  }))
}
