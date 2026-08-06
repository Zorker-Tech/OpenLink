'use client'

import type { ElementReference } from '@/packages/browser-protocol/src/index'
import { ThinkingOrb } from '@/components/thinking/src'
import { BrowserConnection } from '@/lib/browser-runtime/client'
import { useCallback, useEffect, useRef, useState } from 'react'

interface FrameMetrics {
  width: number
  height: number
}

function mappedPoint(container: HTMLElement, frame: FrameMetrics, clientX: number, clientY: number) {
  const rect = container.getBoundingClientRect()
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

export function ChromiumStreamSurface({
  connection,
  inspectMode,
  selectedElement,
}: {
  connection: BrowserConnection
  inspectMode: boolean
  selectedElement: ElementReference | null
}) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const imageRef = useRef<HTMLImageElement | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const pointerStart = useRef<{ x: number; y: number } | null>(null)
  const [frame, setFrame] = useState<FrameMetrics>({ width: connection.state.viewport.width, height: connection.state.viewport.height })
  const [layoutVersion, setLayoutVersion] = useState(0)
  const activePageId = connection.state.activePageId

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
    const observer = new ResizeObserver(() => setLayoutVersion((value) => value + 1))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const point = useCallback((clientX: number, clientY: number) => {
    if (!containerRef.current) return null
    return mappedPoint(containerRef.current, frame, clientX, clientY)
  }, [frame])

  const send = useCallback((action: Parameters<BrowserConnection['sendAction']>[0]) => {
    try { connection.sendAction(action) } catch {}
  }, [connection])

  const overlayStyle = (() => {
    const container = containerRef.current
    if (!selectedElement || !container) return undefined
    const rect = container.getBoundingClientRect()
    const scale = Math.min(rect.width / frame.width, rect.height / frame.height)
    const left = (rect.width - frame.width * scale) / 2
    const top = (rect.height - frame.height * scale) / 2
    return {
      left: left + selectedElement.bounds.x * scale,
      top: top + selectedElement.bounds.y * scale,
      width: selectedElement.bounds.width * scale,
      height: selectedElement.bounds.height * scale,
    }
  })()
  void layoutVersion
  const selectedLabel = selectedElement ? `${selectedElement.componentName || selectedElement.tagName}${selectedElement.source ? ` · ${selectedElement.source}` : ''}` : ''

  return (
    <div
      aria-label="远程 Chromium 实时交互画布"
      className="relative size-full overflow-hidden bg-[#111] outline-none"
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
      <img alt="远程 Chromium 页面" className="pointer-events-none size-full select-none object-contain" draggable={false} ref={imageRef} />
      {!hasFrame && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-[#111] text-sm text-white/70">
          <ThinkingOrb aria-label="正在初始化实时浏览器" size={64} state="shaping" theme="dark" />
          <span>正在初始化实时浏览器</span>
        </div>
      )}
      {overlayStyle && (
        <div className="pointer-events-none absolute z-20 border-2 border-[#6d5dfc] bg-[#6d5dfc]/10" style={overlayStyle}>
          <span className="absolute bottom-full left-[-2px] max-w-64 truncate rounded-t bg-[#6d5dfc] px-1.5 py-0.5 text-[10px] leading-4 text-white">
            {selectedLabel}
          </span>
        </div>
      )}
      <textarea
        aria-label="远程浏览器键盘输入"
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
