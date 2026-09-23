'use client'

import type { ElementReference } from '@/packages/browser-protocol/src/index'
import { ThinkingOrb } from '@/components/thinking/src'
import { useT } from '@/lib/i18n/client'
import { theme } from '@/lib/theme'
import { BrowserConnection } from '@/lib/browser-runtime/client'
import { useCallback, useEffect, useRef, useState } from 'react'

interface FrameMetrics {
  width: number
  height: number
}

function mappedPoint(container: HTMLElement, frame: FrameMetrics, clientX: number, clientY: number, fit: 'fill' | 'contain') {
  const rect = container.getBoundingClientRect()
  if (fit === 'contain') {
    const scale = Math.min(rect.width / frame.width, rect.height / frame.height)
    const displayedWidth = frame.width * scale
    const displayedHeight = frame.height * scale
    const left = rect.left + (rect.width - displayedWidth) / 2
    const top = rect.top + (rect.height - displayedHeight) / 2
    return {
      x: Math.max(0, Math.min(frame.width, (clientX - left) / scale)),
      y: Math.max(0, Math.min(frame.height, (clientY - top) / scale)),
      scale,
      left: left - rect.left,
      top: top - rect.top,
    }
  }
  const scaleX = rect.width / frame.width
  const scaleY = rect.height / frame.height
  return {
    x: Math.max(0, Math.min(frame.width, (clientX - rect.left) / scaleX)),
    y: Math.max(0, Math.min(frame.height, (clientY - rect.top) / scaleY)),
    scale: Math.min(scaleX, scaleY),
    left: 0,
    top: 0,
  }
}

export function ChromiumStreamSurface({
  connection,
  inspectMode,
  selectedElement,
  viewportMode,
}: {
  connection: BrowserConnection
  inspectMode: boolean
  selectedElement: ElementReference | null
  viewportMode: 'mobile' | 'browser'
}) {
  const t = useT()
  const containerRef = useRef<HTMLDivElement | null>(null)
  const imageRef = useRef<HTMLImageElement | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const pointerStart = useRef<{ x: number; y: number } | null>(null)
  const [frame, setFrame] = useState<FrameMetrics>({ width: connection.state.viewport.width, height: connection.state.viewport.height })
  const [layoutVersion, setLayoutVersion] = useState(0)
  const activePageId = connection.state.activePageId
  const fit = viewportMode === 'browser' ? 'fill' : 'contain'

  // A connected Chromium session can take a moment to produce its first
  // screencast frame. Reset on a new connection/page so that the realtime
  // surface presents an intentional loading state instead of a black canvas.
  const [hasFrame, setHasFrame] = useState(false)
  useEffect(() => {
    setHasFrame(false)
  }, [activePageId, connection])

  useEffect(() => connection.onEvent((envelope) => {
    const event = envelope.event
    if (event.type !== 'page.screencast' || event.pageId !== connection.state.activePageId) return
    if (imageRef.current) imageRef.current.src = `data:${event.mimeType};base64,${event.data}`
    setHasFrame(true)
    const nextFrame = { width: event.width, height: event.height }
    setFrame((current) => current.width === nextFrame.width && current.height === nextFrame.height ? current : nextFrame)
  }), [connection])

  useEffect(() => {
    const element = containerRef.current
    if (!element) return
    let resizeFrame: number | undefined
    let retryTimer: number | undefined
    let lastViewport = ''
    const syncViewport = () => {
      resizeFrame = undefined
      setLayoutVersion((value) => value + 1)

      // A stream frame must use the same aspect ratio as the canvas. The
      // previous implementation used the browser window size (with a 1024px
      // minimum), which is often wider than the resizable preview panel and
      // made `object-contain` leave large black bars above and below the page.
      // Keep the remote Chromium viewport tied to the actual canvas instead.
      if (viewportMode !== 'browser') return
      const rect = element.getBoundingClientRect()
      const width = Math.max(240, Math.min(7680, Math.round(rect.width)))
      const height = Math.max(240, Math.min(4320, Math.round(rect.height)))
      const deviceScaleFactor = Math.min(4, Math.max(0.5, window.devicePixelRatio || 1))
      const key = `${width}:${height}:${deviceScaleFactor}`
      if (key === lastViewport) return
      const current = connection.state.viewport
      if (current.width === width && current.height === height && current.deviceScaleFactor === deviceScaleFactor) {
        lastViewport = key
        return
      }
      try {
        connection.sendAction({ type: 'viewport.set', viewport: { width, height, deviceScaleFactor } })
        lastViewport = key
      } catch {
        // The socket may still be connecting. Retry until the connection is
        // ready so the first frame cannot retain the old aspect ratio.
        if (retryTimer === undefined) retryTimer = window.setTimeout(() => {
          retryTimer = undefined
          scheduleViewportSync()
        }, 250)
      }
    }
    const scheduleViewportSync = () => {
      if (resizeFrame !== undefined) return
      resizeFrame = window.requestAnimationFrame(syncViewport)
    }
    const removeStatusListener = connection.onStatus((status) => {
      if (status === 'connected' || status === 'reconnecting') scheduleViewportSync()
    })
    const removeStateListener = connection.onState(() => scheduleViewportSync())
    const observer = new ResizeObserver(scheduleViewportSync)
    observer.observe(element)
    scheduleViewportSync()
    return () => {
      observer.disconnect()
      removeStatusListener()
      removeStateListener()
      if (resizeFrame !== undefined) window.cancelAnimationFrame(resizeFrame)
      if (retryTimer !== undefined) window.clearTimeout(retryTimer)
    }
  }, [connection, viewportMode])

  const point = useCallback((clientX: number, clientY: number) => {
    if (!containerRef.current) return null
    return mappedPoint(containerRef.current, frame, clientX, clientY, fit)
  }, [fit, frame])

  const send = useCallback((action: Parameters<BrowserConnection['sendAction']>[0]) => {
    try { connection.sendAction(action) } catch {}
  }, [connection])

  const overlayStyle = (() => {
    const container = containerRef.current
    if (!selectedElement || !container) return undefined
    const rect = container.getBoundingClientRect()
    if (fit === 'contain') {
      const scale = Math.min(rect.width / frame.width, rect.height / frame.height)
      const left = (rect.width - frame.width * scale) / 2
      const top = (rect.height - frame.height * scale) / 2
      return {
        left: left + selectedElement.bounds.x * scale,
        top: top + selectedElement.bounds.y * scale,
        width: selectedElement.bounds.width * scale,
        height: selectedElement.bounds.height * scale,
      }
    }
    const scaleX = rect.width / frame.width
    const scaleY = rect.height / frame.height
    return {
      left: selectedElement.bounds.x * scaleX,
      top: selectedElement.bounds.y * scaleY,
      width: selectedElement.bounds.width * scaleX,
      height: selectedElement.bounds.height * scaleY,
    }
  })()
  void layoutVersion
  const selectedLabel = selectedElement ? `${selectedElement.componentName || selectedElement.tagName}${selectedElement.source ? ` · ${selectedElement.source}` : ''}` : ''

  return (
    <div
      aria-label={t('远程 Chromium 实时交互画布')}
      className={`relative size-full overflow-hidden outline-none ${theme('editor')}`}
      onContextMenu={(event) => event.preventDefault()}
      onPointerDown={(event) => {
        const mapped = point(event.clientX, event.clientY)
        if (!mapped) return
        pointerStart.current = { x: mapped.x, y: mapped.y }
        inputRef.current?.focus({ preventScroll: true })
        send({ type: 'control.acquire', owner: 'human', ttlMs: 15_000 })
      }}
      onPointerUp={(event) => {
        const start = pointerStart.current
        const end = point(event.clientX, event.clientY)
        pointerStart.current = null
        if (!start || !end || !activePageId) return
        const distance = Math.hypot(end.x - start.x, end.y - start.y)
        if (inspectMode) send({ type: 'element.hover', pageId: activePageId, x: end.x, y: end.y })
        else if (distance > 6) send({ type: 'element.drag', pageId: activePageId, from: start, to: { x: end.x, y: end.y } })
        else send({ type: 'element.click', pageId: activePageId, x: end.x, y: end.y, button: event.button === 2 ? 'right' : event.button === 1 ? 'middle' : 'left' })
      }}
      onWheel={(event) => {
        const mapped = point(event.clientX, event.clientY)
        if (!mapped || !activePageId) return
        event.preventDefault()
        send({ type: 'wheel', pageId: activePageId, x: mapped.x, y: mapped.y, deltaX: event.deltaX, deltaY: event.deltaY })
      }}
      ref={containerRef}
      role="application"
    >
      <img alt={t('远程 Chromium 页面')} className={`pointer-events-none size-full select-none ${fit === 'fill' ? 'object-fill' : 'object-contain'}`} draggable={false} ref={imageRef} />
      {!hasFrame && (
        <div className={`absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 text-sm ${theme('editor', 'muted')}`}>
          <ThinkingOrb aria-label={t('正在初始化实时浏览器')} size={64} state="shaping" />
          <span>{t('正在初始化实时浏览器')}</span>
        </div>
      )}
      {overlayStyle && (
        <div className={`pointer-events-none absolute z-20 border-2 ${theme('inspector')}`} style={overlayStyle}>
          <span className={`absolute bottom-full left-[-2px] max-w-64 truncate rounded-t px-1.5 py-0.5 text-[10px] leading-4 ${theme('inspectorLabel')}`}>
            {selectedLabel}
          </span>
        </div>
      )}
      <textarea
        aria-label={t('远程浏览器键盘输入')}
        className="pointer-events-none absolute left-0 top-0 size-px resize-none opacity-0"
        onChange={(event) => {
          if (event.currentTarget.value && activePageId) send({ type: 'keyboard.insertText', pageId: activePageId, text: event.currentTarget.value })
          event.currentTarget.value = ''
        }}
        onCompositionEnd={(event) => {
          if (event.data && activePageId) send({ type: 'keyboard.insertText', pageId: activePageId, text: event.data })
          event.currentTarget.value = ''
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || !activePageId) return
          if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) return
          event.preventDefault()
          const modifiers = [event.metaKey && 'Meta', event.ctrlKey && 'Control', event.altKey && 'Alt', event.shiftKey && 'Shift'].filter(Boolean) as string[]
          send({ type: 'keyboard.key', pageId: activePageId, key: event.key, modifiers })
        }}
        ref={inputRef}
      />
    </div>
  )
}
