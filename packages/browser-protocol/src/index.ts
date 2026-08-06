export const BROWSER_PROTOCOL_VERSION = 1 as const
export const INSPECTOR_BRIDGE_CHANNEL = 'openlink.browser.inspector' as const

export type BrowserProtocolVersion = typeof BROWSER_PROTOCOL_VERSION
export type BrowserSurfaceKind = 'native-preview' | 'chromium-stream' | 'desktop-integrated'
export type BrowserSessionStatus = 'starting' | 'ready' | 'suspended' | 'closing' | 'closed' | 'failed'
export type BrowserControlOwner = 'human' | 'agent' | null

export interface BrowserViewport {
  width: number
  height: number
  deviceScaleFactor: number
}

export interface BrowserPageState {
  id: string
  url: string
  title: string
  faviconUrl?: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  active: boolean
}

export interface BrowserSessionCapabilities {
  nativeDom: boolean
  screencast: boolean
  componentInspection: boolean
  downloads: boolean
  uploads: boolean
  dialogs: boolean
  devtools: boolean
}

export interface BrowserSessionState {
  version: BrowserProtocolVersion
  id: string
  ownerId: string
  workspaceId: string
  projectId: string
  surface: BrowserSurfaceKind
  status: BrowserSessionStatus
  createdAt: string
  updatedAt: string
  expiresAt: string
  controlOwner: BrowserControlOwner
  controlLeaseExpiresAt?: string
  activePageId?: string
  pages: BrowserPageState[]
  viewport: BrowserViewport
  capabilities: BrowserSessionCapabilities
  previewUrl?: string
  error?: BrowserErrorPayload
}

export interface BrowserErrorPayload {
  code: string
  message: string
  recoverable: boolean
}

export interface ElementReference {
  ref: string
  tagName: string
  role?: string
  text?: string
  selector?: string
  componentName?: string
  source?: string
  bounds: { x: number; y: number; width: number; height: number }
  attributes: Record<string, string>
}

export type BrowserAction =
  | { type: 'page.open'; url: string }
  | { type: 'page.close'; pageId: string }
  | { type: 'page.activate'; pageId: string }
  | { type: 'page.navigate'; pageId: string; url: string }
  | { type: 'page.back'; pageId: string }
  | { type: 'page.forward'; pageId: string }
  | { type: 'page.reload'; pageId: string }
  | { type: 'page.read'; pageId: string }
  | { type: 'page.screenshot'; pageId: string; fullPage?: boolean }
  | { type: 'element.click'; pageId: string; ref?: string; selector?: string; x?: number; y?: number; button?: 'left' | 'middle' | 'right'; clickCount?: number }
  | { type: 'element.hover'; pageId: string; ref?: string; selector?: string; x?: number; y?: number }
  | { type: 'element.type'; pageId: string; ref?: string; selector?: string; text: string; submit?: boolean }
  | { type: 'element.drag'; pageId: string; from: { x: number; y: number }; to: { x: number; y: number } }
  | { type: 'keyboard.key'; pageId: string; key: string; modifiers?: string[] }
  | { type: 'keyboard.insertText'; pageId: string; text: string }
  | { type: 'wheel'; pageId: string; x: number; y: number; deltaX: number; deltaY: number }
  | { type: 'viewport.set'; viewport: BrowserViewport }
  | { type: 'dialog.handle'; pageId: string; accept: boolean; promptText?: string }
  | { type: 'control.acquire'; owner: Exclude<BrowserControlOwner, null>; ttlMs?: number }
  | { type: 'control.release'; owner: Exclude<BrowserControlOwner, null> }

export interface BrowserActionEnvelope {
  version: BrowserProtocolVersion
  actionId: string
  sessionId: string
  actor: Exclude<BrowserControlOwner, null>
  action: BrowserAction
}

export interface BrowserActionResult {
  version: BrowserProtocolVersion
  actionId: string
  sessionId: string
  ok: boolean
  page?: BrowserPageState
  element?: ElementReference
  snapshot?: string
  image?: { mimeType: 'image/png' | 'image/jpeg'; data: string; width?: number; height?: number }
  error?: BrowserErrorPayload
}

export type BrowserEvent =
  | { type: 'session.state'; state: BrowserSessionState }
  | { type: 'page.state'; page: BrowserPageState }
  | { type: 'page.closed'; pageId: string }
  | { type: 'page.console'; pageId: string; level: string; text: string; timestamp: string }
  | { type: 'page.dialog'; pageId: string; dialogType: string; message: string; defaultValue: string }
  | { type: 'page.download'; pageId: string; downloadId: string; suggestedFilename: string; state: 'pending' | 'complete' | 'failed' }
  | { type: 'page.screencast'; pageId: string; frameId: number; mimeType: 'image/jpeg'; data: string; width: number; height: number; deviceScaleFactor: number }
  | { type: 'inspector.hover'; pageId: string; element: ElementReference }
  | { type: 'inspector.selected'; pageId: string; element: ElementReference }
  | { type: 'bridge.command'; commandId: string; action: BrowserActionEnvelope }
  | { type: 'action.result'; result: BrowserActionResult }
  | { type: 'runtime.error'; error: BrowserErrorPayload }

export interface BrowserEventEnvelope {
  version: BrowserProtocolVersion
  sessionId: string
  sequence: number
  timestamp: string
  event: BrowserEvent
}

export type BrowserSocketClientMessage =
  | { type: 'action'; payload: BrowserActionEnvelope }
  | { type: 'bridge.result'; commandId: string; result: BrowserActionResult }
  | { type: 'subscribe'; afterSequence?: number }
  | { type: 'ping'; nonce: string }

export type BrowserSocketServerMessage =
  | { type: 'event'; payload: BrowserEventEnvelope }
  | { type: 'snapshot'; payload: BrowserSessionState; sequence: number }
  | { type: 'pong'; nonce: string }
  | { type: 'error'; error: BrowserErrorPayload }

export type InspectorBridgeCommand =
  | { type: 'inspect.start' }
  | { type: 'inspect.stop' }
  | { type: 'element.activate'; ref: string }
  | { type: 'element.snapshot'; ref?: string }
  | { type: 'action.execute'; envelope: BrowserActionEnvelope }

export type InspectorBridgeEvent =
  | { type: 'bridge.ready'; url: string; title: string }
  | { type: 'page.updated'; url: string; title: string }
  | { type: 'human.activity'; activity: 'pointer' | 'keyboard' | 'scroll' }
  | { type: 'inspect.hover'; element: ElementReference }
  | { type: 'inspect.selected'; element: ElementReference }
  | { type: 'action.result'; result: BrowserActionResult }
  | { type: 'bridge.error'; message: string }

export interface InspectorBridgeEnvelope<T extends InspectorBridgeCommand | InspectorBridgeEvent = InspectorBridgeCommand | InspectorBridgeEvent> {
  channel: typeof INSPECTOR_BRIDGE_CHANNEL
  version: BrowserProtocolVersion
  sessionId: string
  nonce: string
  payload: T
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

export function isBrowserViewport(value: unknown): value is BrowserViewport {
  if (!isRecord(value)) return false
  return isFiniteNumber(value.width) && value.width >= 240 && value.width <= 7680
    && isFiniteNumber(value.height) && value.height >= 240 && value.height <= 4320
    && isFiniteNumber(value.deviceScaleFactor) && value.deviceScaleFactor >= 0.5 && value.deviceScaleFactor <= 4
}

export function isBrowserActionEnvelope(value: unknown): value is BrowserActionEnvelope {
  if (!isRecord(value) || value.version !== BROWSER_PROTOCOL_VERSION || !isString(value.actionId)
    || !isString(value.sessionId) || (value.actor !== 'human' && value.actor !== 'agent') || !isRecord(value.action)) return false

  const action = value.action
  if (!isString(action.type)) return false
  const pageId = () => isString(action.pageId)
  const url = () => isString(action.url) && action.url.length <= 8192
  const point = (candidate: unknown) => isRecord(candidate) && isFiniteNumber(candidate.x) && isFiniteNumber(candidate.y)
  switch (action.type) {
    case 'page.open': return url()
    case 'page.close':
    case 'page.activate':
    case 'page.back':
    case 'page.forward':
    case 'page.reload':
    case 'page.read': return pageId()
    case 'page.navigate': return pageId() && url()
    case 'page.screenshot': return pageId() && (action.fullPage === undefined || typeof action.fullPage === 'boolean')
    case 'element.click': return pageId() && (isString(action.ref) || isString(action.selector) || (isFiniteNumber(action.x) && isFiniteNumber(action.y)))
    case 'element.hover': return pageId() && (isString(action.ref) || isString(action.selector) || (isFiniteNumber(action.x) && isFiniteNumber(action.y)))
    case 'element.type': return pageId() && isString(action.text) && (isString(action.ref) || isString(action.selector))
    case 'element.drag': return pageId() && point(action.from) && point(action.to)
    case 'keyboard.key': return pageId() && isString(action.key)
    case 'keyboard.insertText': return pageId() && isString(action.text)
    case 'wheel': return pageId() && ['x', 'y', 'deltaX', 'deltaY'].every((key) => isFiniteNumber(action[key]))
    case 'viewport.set': return isBrowserViewport(action.viewport)
    case 'dialog.handle': return pageId() && typeof action.accept === 'boolean'
    case 'control.acquire': return (action.owner === 'human' || action.owner === 'agent') && (action.ttlMs === undefined || isFiniteNumber(action.ttlMs))
    case 'control.release': return action.owner === 'human' || action.owner === 'agent'
    default: return false
  }
}

export function isBrowserSocketClientMessage(value: unknown): value is BrowserSocketClientMessage {
  if (!isRecord(value) || !isString(value.type)) return false
  if (value.type === 'action') return isBrowserActionEnvelope(value.payload)
  if (value.type === 'bridge.result') {
    return isString(value.commandId) && isRecord(value.result)
      && value.result.version === BROWSER_PROTOCOL_VERSION
      && isString(value.result.actionId)
      && isString(value.result.sessionId)
      && typeof value.result.ok === 'boolean'
  }
  if (value.type === 'subscribe') return value.afterSequence === undefined || (Number.isSafeInteger(value.afterSequence) && Number(value.afterSequence) >= 0)
  return value.type === 'ping' && isString(value.nonce) && value.nonce.length <= 128
}

export function isInspectorBridgeEnvelope(value: unknown): value is InspectorBridgeEnvelope {
  return isRecord(value)
    && value.channel === INSPECTOR_BRIDGE_CHANNEL
    && value.version === BROWSER_PROTOCOL_VERSION
    && isString(value.sessionId)
    && isString(value.nonce)
    && isRecord(value.payload)
    && isString(value.payload.type)
}
