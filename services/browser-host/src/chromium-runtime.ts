import { mkdir, readlink, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { hostname } from 'node:os'
import { createHash, randomBytes } from 'node:crypto'
import {
  BROWSER_PROTOCOL_VERSION,
  type BrowserActionEnvelope,
  type BrowserActionResult,
  type BrowserPageState,
  type BrowserViewport,
  type ElementReference,
} from '@openlink/browser-protocol'
import { chromium, type BrowserContext, type CDPSession, type Dialog, type Page } from 'playwright-core'
import { BrowserHostError } from './errors.js'
import { BrowserNetworkGuard, type BrowserNetworkPolicy } from './network-policy.js'
import { BrowserEgressProxy } from './egress-proxy.js'
import type { BrowserRuntimeSession, BrowserSessionRuntimeContext } from './session-manager.js'

export interface ChromiumRuntimeOptions {
  executablePath: string
  storageRoot: string
  initialUrl?: string
  headless?: boolean
  networkPolicy: BrowserNetworkPolicy
  preserveProfile?: boolean
  profileKey?: string
  /** Headers injected only for the trusted initial Project-preview origin. */
  initialRequestHeaders?: Record<string, string>
}

interface TrackedPage {
  id: string
  page: Page
  cdp: CDPSession
  dialog?: Dialog
  frameId: number
}

interface AxNode {
  nodeId: string
  ignored: boolean
  role?: { value?: unknown }
  name?: { value?: unknown }
  description?: { value?: unknown }
  value?: { value?: unknown }
  backendDOMNodeId?: number
  properties?: Array<{ name: string; value?: { value?: unknown } }>
}

function pageId(): string {
  return randomBytes(12).toString('base64url')
}

function backendRef(backendNodeId: number): string {
  return `backend:${backendNodeId}`
}

function parseBackendRef(ref: string | undefined): number | undefined {
  const match = /^backend:(\d+)$/.exec(ref ?? '')
  return match ? Number(match[1]) : undefined
}

function asText(value: unknown): string | undefined {
  if (typeof value === 'string') return value.slice(0, 1000)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return undefined
}

export function isProcessSingletonFailure(error: unknown): boolean {
  return /process[_ ]?singleton|SingletonLock|profile(?: directory)? appears to be in use/i.test(error instanceof Error ? error.message : String(error))
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means the process exists but belongs to another UID; it is still
    // an active Chromium lock and must not be removed.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export function chromiumSingletonOwner(target: string): { hostname: string; pid: number } | null {
  const match = /^(.+)-(\d+)$/.exec(target)
  if (!match) return null
  const pid = Number(match[2])
  if (!match[1] || !Number.isSafeInteger(pid) || pid <= 1) return null
  return { hostname: match[1], pid }
}

export class ChromiumRuntime implements BrowserRuntimeSession {
  readonly surface = 'chromium-stream' as const
  private context?: BrowserContext
  private readonly pages = new Map<string, TrackedPage>()
  private readonly pageIds = new WeakMap<Page, string>()
  private readonly tracking = new WeakMap<Page, Promise<void>>()
  private readonly network: BrowserNetworkGuard
  private readonly egressProxy: BrowserEgressProxy
  private readonly initialRequestOrigin?: string
  private profilePath: string
  private closed = false

  constructor(
    private readonly runtimeContext: BrowserSessionRuntimeContext,
    private readonly options: ChromiumRuntimeOptions,
  ) {
    if (!options.executablePath) throw new BrowserHostError('CHROMIUM_NOT_CONFIGURED', 'Chromium executable path is required', 503)
    this.network = new BrowserNetworkGuard(options.networkPolicy)
    this.egressProxy = new BrowserEgressProxy(this.network)
    const stableProfileKey = options.profileKey || runtimeContext.sessionId
    const profileId = createHash('sha256')
      .update(`${runtimeContext.ownerId}\0${runtimeContext.workspaceId}\0${runtimeContext.projectId}\0${stableProfileKey}`)
      .digest('hex')
    this.profilePath = join(options.storageRoot, 'profiles', profileId)
    this.initialRequestOrigin = options.initialUrl && options.initialRequestHeaders
      ? new URL(options.initialUrl).origin
      : undefined
  }

  async start(): Promise<void> {
    await mkdir(this.profilePath, { recursive: true, mode: 0o700 })
    await this.egressProxy.start()
    const viewport = this.runtimeContext.getState().viewport
    const launch = () => chromium.launchPersistentContext(this.profilePath, {
      executablePath: this.options.executablePath,
      headless: this.options.headless ?? true,
      viewport: { width: viewport.width, height: viewport.height },
      deviceScaleFactor: viewport.deviceScaleFactor,
      acceptDownloads: true,
      bypassCSP: false,
      ignoreHTTPSErrors: false,
      proxy: { server: this.egressProxy.url, bypass: '<-loopback>' },
      args: ['--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run'],
    })
    try {
      this.context = await launch()
    } catch (error) {
      // A Browser Host crash can leave Chromium's three ProcessSingleton
      // marker files behind. Never delete an active profile lock: the session
      // manager provides normal mutual exclusion and this recovery only
      // removes a lock whose owning PID is demonstrably gone. Retry once so a
      // corrupt/stale marker is repaired without turning a transient launch
      // failure into an infinite restart loop.
      if (!isProcessSingletonFailure(error) || !await this.removeStaleProfileLock()) throw error
      this.context = await launch()
    }
    await this.context.route('**/*', async (route) => {
      try {
        await this.network.assertUrl(route.request().url())
        const requestUrl = new URL(route.request().url())
        // The OpenSandbox API key belongs only on the Project VM's internal
        // preview-proxy origin. Never use Playwright's context-wide headers:
        // those would leak it if the user later navigated elsewhere.
        if (this.initialRequestOrigin && requestUrl.origin === this.initialRequestOrigin) {
          await route.continue({ headers: { ...route.request().headers(), ...this.options.initialRequestHeaders } })
        } else {
          await route.continue()
        }
      } catch {
        await route.abort('blockedbyclient')
      }
    })
    this.context.on('page', (page) => void this.trackPage(page))

    const existing = this.context.pages()
    const first = existing[0] ?? await this.context.newPage()
    for (const page of this.context.pages()) await this.trackPage(page)
    if (this.options.initialUrl) {
      await this.network.assertUrl(this.options.initialUrl)
      await first.goto(this.options.initialUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    }
    await this.refreshState(this.pageIds.get(first))
  }

  private async removeStaleProfileLock(): Promise<boolean> {
    const lock = join(this.profilePath, 'SingletonLock')
    let target: string
    try {
      target = await readlink(lock)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      return false
    }
    // Chromium creates a symlink named "<hostname>-<pid>". A Project Browser
    // service container gets a new hostname when it is reconciled after a
    // restart, while the durable profile survives. In that case the PID is
    // from a different PID namespace and may coincidentally be alive in this
    // new container; treating it as local strands the profile forever. Only
    // consult kill(0) when the recorded hostname is this exact runtime.
    // Unknown lock formats remain fail-closed.
    const owner = chromiumSingletonOwner(target)
    if (!owner || (owner.hostname === hostname() && processAlive(owner.pid))) return false
    await Promise.all([
      rm(lock, { force: true }),
      rm(join(this.profilePath, 'SingletonCookie'), { force: true }),
      rm(join(this.profilePath, 'SingletonSocket'), { force: true }),
    ])
    return true
  }

  async perform(envelope: BrowserActionEnvelope): Promise<BrowserActionResult> {
    const action = envelope.action
    if (action.type === 'page.open') {
      await this.network.assertUrl(action.url)
      const page = await this.requireContext().newPage()
      await this.trackPage(page)
      await page.goto(action.url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
      const id = this.pageIds.get(page)!
      await this.refreshState(id)
      return this.ok(envelope, { page: await this.pageState(this.pages.get(id)!) })
    }
    if (action.type === 'viewport.set') {
      await this.setViewport(action.viewport)
      return this.ok(envelope)
    }

    const tracked = this.requirePage('pageId' in action ? action.pageId : undefined)
    const { page, cdp } = tracked
    switch (action.type) {
      case 'page.close':
        await page.close()
        return this.ok(envelope)
      case 'page.activate':
        await page.bringToFront()
        await this.refreshState(tracked.id)
        return this.ok(envelope, { page: await this.pageState(tracked) })
      case 'page.navigate':
        await this.network.assertUrl(action.url)
        await page.goto(action.url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
        return this.ok(envelope, { page: await this.pageState(tracked) })
      case 'page.back':
        await page.goBack({ waitUntil: 'domcontentloaded', timeout: 30_000 })
        return this.ok(envelope, { page: await this.pageState(tracked) })
      case 'page.forward':
        await page.goForward({ waitUntil: 'domcontentloaded', timeout: 30_000 })
        return this.ok(envelope, { page: await this.pageState(tracked) })
      case 'page.reload':
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 })
        return this.ok(envelope, { page: await this.pageState(tracked) })
      case 'page.read':
        return this.ok(envelope, { snapshot: await this.accessibilitySnapshot(cdp) })
      case 'page.screenshot': {
        const buffer = await page.screenshot({ type: 'jpeg', quality: 85, fullPage: action.fullPage ?? false })
        return this.ok(envelope, { image: { mimeType: 'image/jpeg', data: buffer.toString('base64') } })
      }
      case 'element.click': {
        const element = await this.resolveElement(tracked, action.ref, action.selector, action.x, action.y)
        if (action.selector) await page.locator(action.selector).click({ button: action.button ?? 'left', clickCount: action.clickCount ?? 1 })
        else await page.mouse.click(element.bounds.x + element.bounds.width / 2, element.bounds.y + element.bounds.height / 2, { button: action.button ?? 'left', clickCount: action.clickCount ?? 1 })
        return this.ok(envelope, { element })
      }
      case 'element.hover': {
        const element = await this.resolveElement(tracked, action.ref, action.selector, action.x, action.y)
        if (action.selector) await page.locator(action.selector).hover()
        else await page.mouse.move(element.bounds.x + element.bounds.width / 2, element.bounds.y + element.bounds.height / 2)
        return this.ok(envelope, { element })
      }
      case 'element.type': {
        if (action.selector) await page.locator(action.selector).fill(action.text)
        else {
          const backendNodeId = parseBackendRef(action.ref)
          if (!backendNodeId) throw new BrowserHostError('ELEMENT_REFERENCE_INVALID', 'A valid element reference or selector is required', 400)
          const element = await this.describeBackendNode(cdp, backendNodeId)
          const resolved = await cdp.send('DOM.resolveNode', { backendNodeId }) as { object?: { objectId?: string } }
          if (!resolved.object?.objectId) throw new BrowserHostError('ELEMENT_NOT_FOUND', 'Element is no longer attached', 404, true)
          await cdp.send('Runtime.callFunctionOn', {
            objectId: resolved.object.objectId,
            functionDeclaration: `function(value) { this.focus(); const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(this), 'value')?.set; if (setter) setter.call(this, value); else this.value = value; this.dispatchEvent(new InputEvent('input', { bubbles: true, data: value, inputType: 'insertText' })); this.dispatchEvent(new Event('change', { bubbles: true })); }`,
            arguments: [{ value: action.text }],
          })
          if (action.submit) await page.keyboard.press('Enter')
          return this.ok(envelope, { element })
        }
        if (action.submit) await page.keyboard.press('Enter')
        return this.ok(envelope)
      }
      case 'element.drag':
        await page.mouse.move(action.from.x, action.from.y)
        await page.mouse.down()
        await page.mouse.move(action.to.x, action.to.y, { steps: 12 })
        await page.mouse.up()
        return this.ok(envelope)
      case 'keyboard.key':
        await page.keyboard.press([...action.modifiers ?? [], action.key].join('+'))
        return this.ok(envelope)
      case 'keyboard.insertText':
        await page.keyboard.insertText(action.text)
        return this.ok(envelope)
      case 'wheel':
        await page.mouse.move(action.x, action.y)
        await page.mouse.wheel(action.deltaX, action.deltaY)
        return this.ok(envelope)
      case 'dialog.handle': {
        const dialog = tracked.dialog
        if (!dialog) throw new BrowserHostError('DIALOG_NOT_FOUND', 'No dialog is awaiting a response', 404, true)
        tracked.dialog = undefined
        if (action.accept) await dialog.accept(action.promptText)
        else await dialog.dismiss()
        return this.ok(envelope)
      }
      default:
        throw new BrowserHostError('ACTION_NOT_SUPPORTED', `Unsupported Chromium action: ${(action as { type: string }).type}`, 400)
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    for (const tracked of this.pages.values()) await tracked.cdp.detach().catch(() => undefined)
    this.pages.clear()
    await this.context?.close().catch(() => undefined)
    await this.egressProxy.close().catch(() => undefined)
    if (!this.options.preserveProfile) await rm(this.profilePath, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }

  private requireContext(): BrowserContext {
    if (!this.context || this.closed) throw new BrowserHostError('CHROMIUM_NOT_READY', 'Chromium runtime is not ready', 409, true)
    return this.context
  }

  private requirePage(id: string | undefined): TrackedPage {
    const tracked = id ? this.pages.get(id) : undefined
    if (!tracked) throw new BrowserHostError('PAGE_NOT_FOUND', 'Browser page not found', 404, true)
    return tracked
  }

  private async trackPage(page: Page): Promise<void> {
    const existing = this.tracking.get(page)
    if (existing) return existing
    const pending = this.initializeTrackedPage(page)
    this.tracking.set(page, pending)
    return pending
  }

  private async initializeTrackedPage(page: Page): Promise<void> {
    const id = pageId()
    this.pageIds.set(page, id)
    const cdp = await this.requireContext().newCDPSession(page)
    const tracked: TrackedPage = { id, page, cdp, frameId: 0 }
    this.pages.set(id, tracked)
    page.on('close', () => {
      this.pages.delete(id)
      this.runtimeContext.emit({ type: 'page.closed', pageId: id })
      void this.refreshState()
    })
    page.on('domcontentloaded', () => void this.emitPageState(tracked))
    page.on('load', () => void this.emitPageState(tracked))
    page.on('console', (message) => this.runtimeContext.emit({
      type: 'page.console', pageId: id, level: message.type(), text: message.text().slice(0, 20_000), timestamp: new Date().toISOString(),
    }))
    page.on('dialog', (dialog) => {
      tracked.dialog = dialog
      this.runtimeContext.emit({ type: 'page.dialog', pageId: id, dialogType: dialog.type(), message: dialog.message(), defaultValue: dialog.defaultValue() })
    })
    page.on('download', (download) => {
      const downloadId = randomBytes(12).toString('base64url')
      const suggestedFilename = download.suggestedFilename().replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 180) || 'download'
      this.runtimeContext.emit({ type: 'page.download', pageId: id, downloadId, suggestedFilename, state: 'pending' })
      void (async () => {
        try {
          const directory = join(this.options.storageRoot, 'downloads', this.runtimeContext.sessionId)
          await mkdir(directory, { recursive: true, mode: 0o700 })
          await download.saveAs(join(directory, `${downloadId}-${suggestedFilename}`))
          this.runtimeContext.emit({ type: 'page.download', pageId: id, downloadId, suggestedFilename, state: 'complete' })
        } catch {
          this.runtimeContext.emit({ type: 'page.download', pageId: id, downloadId, suggestedFilename, state: 'failed' })
        }
      })()
    })
    cdp.on('Page.screencastFrame', (event: { data: string; sessionId: number; metadata?: { deviceWidth?: number; deviceHeight?: number } }) => {
      const viewport = this.runtimeContext.getState().viewport
      this.runtimeContext.emit({
        type: 'page.screencast', pageId: id, frameId: ++tracked.frameId, mimeType: 'image/jpeg', data: event.data,
        width: event.metadata?.deviceWidth ?? viewport.width,
        height: event.metadata?.deviceHeight ?? viewport.height,
        deviceScaleFactor: viewport.deviceScaleFactor,
      })
      void cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => undefined)
    })
    await cdp.send('Page.enable')
    await cdp.send('DOM.enable')
    await cdp.send('Accessibility.enable')
    const viewport = this.runtimeContext.getState().viewport
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 80, maxWidth: viewport.width, maxHeight: viewport.height, everyNthFrame: 1 })
    await this.refreshState(id)
  }

  private async setViewport(viewport: BrowserViewport): Promise<void> {
    await Promise.all([...this.pages.values()].map(async (tracked) => {
      await tracked.page.setViewportSize({ width: viewport.width, height: viewport.height })
      await tracked.cdp.send('Emulation.setDeviceMetricsOverride', {
        width: viewport.width, height: viewport.height, deviceScaleFactor: viewport.deviceScaleFactor, mobile: false,
      })
      await tracked.cdp.send('Page.stopScreencast').catch(() => undefined)
      await tracked.cdp.send('Page.startScreencast', { format: 'jpeg', quality: 80, maxWidth: viewport.width, maxHeight: viewport.height, everyNthFrame: 1 })
    }))
    this.runtimeContext.update((state) => ({ ...state, viewport }))
  }

  private async pageState(tracked: TrackedPage): Promise<BrowserPageState> {
    let currentIndex = 0
    let entries: unknown[] = []
    try {
      const history = await tracked.cdp.send('Page.getNavigationHistory') as { currentIndex: number; entries: unknown[] }
      currentIndex = history.currentIndex
      entries = history.entries
    } catch {}
    return {
      id: tracked.id,
      url: tracked.page.url(),
      title: (await tracked.page.title().catch(() => '')) || 'New tab',
      loading: false,
      canGoBack: currentIndex > 0,
      canGoForward: currentIndex < entries.length - 1,
      active: this.runtimeContext.getState().activePageId === tracked.id,
    }
  }

  private async refreshState(activePageId?: string): Promise<void> {
    const states = await Promise.all([...this.pages.values()].map((tracked) => this.pageState(tracked)))
    const active = activePageId ?? this.runtimeContext.getState().activePageId ?? states[0]?.id
    this.runtimeContext.update((state) => ({
      ...state,
      status: 'ready',
      activePageId: active,
      pages: states.map((page) => ({ ...page, active: page.id === active })),
    }))
  }

  private async emitPageState(tracked: TrackedPage): Promise<void> {
    const state = await this.pageState(tracked)
    this.runtimeContext.emit({ type: 'page.state', page: state })
    await this.refreshState(this.runtimeContext.getState().activePageId)
  }

  private async accessibilitySnapshot(cdp: CDPSession): Promise<string> {
    const response = await cdp.send('Accessibility.getFullAXTree') as { nodes: AxNode[] }
    const nodes = response.nodes.filter((node) => !node.ignored).slice(0, 5000).map((node) => ({
      ref: node.backendDOMNodeId ? backendRef(node.backendDOMNodeId) : undefined,
      role: asText(node.role?.value),
      name: asText(node.name?.value),
      description: asText(node.description?.value),
      value: asText(node.value?.value),
      properties: Object.fromEntries((node.properties ?? []).map((property) => [property.name, asText(property.value?.value)]).filter((entry) => entry[1] !== undefined)),
    }))
    return JSON.stringify({ url: this.runtimeContext.getState().pages.find((page) => page.active)?.url, nodes })
  }

  private async resolveElement(tracked: TrackedPage, ref?: string, selector?: string, x?: number, y?: number): Promise<ElementReference> {
    if (selector) {
      const locator = tracked.page.locator(selector).first()
      const bounds = await locator.boundingBox()
      if (!bounds) throw new BrowserHostError('ELEMENT_NOT_FOUND', 'Element is not visible', 404, true)
      return { ref: `selector:${selector}`, tagName: 'element', selector, bounds, attributes: {} }
    }
    let backendNodeId = parseBackendRef(ref)
    if (!backendNodeId && typeof x === 'number' && Number.isFinite(x) && typeof y === 'number' && Number.isFinite(y)) {
      // CDP's DOM.getNodeForLocation schema uses integer CSS viewport
      // coordinates. The streamed surface maps pointer coordinates through a
      // scaled image, so fractional values are expected at this boundary.
      // Normalize and clamp here instead of letting every client implement
      // protocol-specific coordinate rules.
      const viewport = this.runtimeContext.getState().viewport
      const location = {
        x: Math.max(0, Math.min(viewport.width - 1, Math.round(x))),
        y: Math.max(0, Math.min(viewport.height - 1, Math.round(y))),
      }
      const result = await tracked.cdp.send('DOM.getNodeForLocation', { ...location, includeUserAgentShadowDOM: true }) as { backendNodeId?: number }
      backendNodeId = result.backendNodeId
    }
    if (!backendNodeId) throw new BrowserHostError('ELEMENT_REFERENCE_INVALID', 'A valid element reference, selector, or point is required', 400)
    return this.describeBackendNode(tracked.cdp, backendNodeId)
  }

  private async describeBackendNode(cdp: CDPSession, backendNodeId: number): Promise<ElementReference> {
    const described = await cdp.send('DOM.describeNode', { backendNodeId, depth: 0, pierce: true }) as {
      node: { localName?: string; nodeName: string; attributes?: string[]; nodeValue?: string }
    }
    const model = await cdp.send('DOM.getBoxModel', { backendNodeId }) as { model?: { border?: number[]; width: number; height: number } }
    const quad = model.model?.border ?? []
    const xs = quad.filter((_, index) => index % 2 === 0)
    const ys = quad.filter((_, index) => index % 2 === 1)
    if (xs.length === 0 || ys.length === 0) throw new BrowserHostError('ELEMENT_NOT_VISIBLE', 'Element has no visible box', 404, true)
    const attributes: Record<string, string> = {}
    const rawAttributes = described.node.attributes ?? []
    for (let index = 0; index < rawAttributes.length - 1; index += 2) attributes[rawAttributes[index]] = rawAttributes[index + 1]
    return {
      ref: backendRef(backendNodeId),
      tagName: described.node.localName || described.node.nodeName.toLowerCase(),
      role: attributes.role,
      text: described.node.nodeValue?.slice(0, 240),
      componentName: attributes['data-openlink-component'],
      source: attributes['data-openlink-source'],
      attributes,
      bounds: { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) },
    }
  }

  private ok(envelope: BrowserActionEnvelope, result: Partial<BrowserActionResult> = {}): BrowserActionResult {
    return { version: BROWSER_PROTOCOL_VERSION, actionId: envelope.actionId, sessionId: envelope.sessionId, ok: true, ...result }
  }
}
