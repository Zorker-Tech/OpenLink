'use client'

import {
  BROWSER_PROTOCOL_VERSION,
  INSPECTOR_BRIDGE_CHANNEL,
  isInspectorBridgeEnvelope,
  type ElementReference,
  type InspectorBridgeEvent,
  type InspectorBridgeEnvelope,
} from '@/packages/browser-protocol/src/index'
import { BrowserConnection } from '@/lib/browser-runtime/client'
import { useT } from '@/lib/i18n/client'
import { theme } from '@/lib/theme'
import { useEffect, useMemo, useRef } from 'react'
import { useState } from 'react'

export function NativePreviewSurface({
  connection,
  inspectMode,
  annotationMode,
  onElementSelected,
  onElementMoved,
  onAnnotationSelect,
}: {
  connection: BrowserConnection
  inspectMode: boolean
  annotationMode: boolean
  onElementSelected: (element: ElementReference | null) => void
  onElementMoved: (move: Extract<InspectorBridgeEvent, { type: 'inspect.moved' }>) => void
  onAnnotationSelect: (selection: { x: number; y: number; width?: number; height?: number }) => void
}) {
  const t = useT()
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const commandIds = useRef(new Map<string, string>())
  const pendingCommands = useRef(new Map<string, InspectorBridgeEnvelope['payload']>())
  const selectionStart = useRef<{ x: number; y: number } | null>(null)
  const [selectionRect, setSelectionRect] = useState<{ x: number; y: number; width: number; height: number } | null>(null)
  const iframeUrl = connection.descriptor.connection.previewUrl
  const nonce = connection.descriptor.connection.bridgeNonce
  const sandbox = useMemo(() => {
    if (!iframeUrl || typeof window === 'undefined') return 'allow-scripts allow-forms allow-popups allow-downloads allow-modals allow-pointer-lock allow-presentation'
    const crossOrigin = new URL(iframeUrl, window.location.href).origin !== window.location.origin
    return `allow-scripts allow-forms allow-popups allow-downloads allow-modals allow-pointer-lock allow-presentation${crossOrigin ? ' allow-same-origin' : ''}`
  }, [iframeUrl])

  const post = (payload: InspectorBridgeEnvelope['payload']) => {
    if (!iframeRef.current?.contentWindow || !nonce) return
    iframeRef.current.contentWindow.postMessage({
      channel: INSPECTOR_BRIDGE_CHANNEL,
      version: BROWSER_PROTOCOL_VERSION,
      sessionId: connection.state.id,
      nonce,
      payload,
    } satisfies InspectorBridgeEnvelope, '*')
  }

  useEffect(() => connection.onEvent((envelope) => {
    if (envelope.event.type !== 'bridge.command') return
    commandIds.current.set(envelope.event.action.actionId, envelope.event.commandId)
    const payload = { type: 'action.execute' as const, envelope: envelope.event.action }
    pendingCommands.current.set(envelope.event.action.actionId, payload)
    post(payload)
  }), [connection, nonce])

  useEffect(() => {
    const listener = (event: MessageEvent<unknown>) => {
      if (event.source !== iframeRef.current?.contentWindow || !isInspectorBridgeEnvelope(event.data)) return
      const message = event.data as InspectorBridgeEnvelope<InspectorBridgeEvent>
      if (message.sessionId !== connection.state.id || message.nonce !== nonce) return
      if (message.payload.type === 'bridge.ready') {
        post(inspectMode ? { type: 'inspect.start' } : { type: 'inspect.stop' })
        for (const payload of pendingCommands.current.values()) post(payload)
      }
      if (message.payload.type === 'inspect.selected') onElementSelected(message.payload.element)
      if (message.payload.type === 'inspect.moved') onElementMoved(message.payload)
      if (message.payload.type === 'human.activity') {
        try { connection.sendAction({ type: 'control.acquire', owner: 'human', ttlMs: 15_000 }) } catch {}
      }
      if (message.payload.type === 'action.result') {
        const commandId = commandIds.current.get(message.payload.result.actionId)
        if (!commandId) return
        commandIds.current.delete(message.payload.result.actionId)
        pendingCommands.current.delete(message.payload.result.actionId)
        connection.sendBridgeResult(commandId, message.payload.result)
      }
    }
    window.addEventListener('message', listener)
    return () => window.removeEventListener('message', listener)
  }, [connection, nonce, onElementMoved, onElementSelected])

  useEffect(() => {
    post(inspectMode ? { type: 'inspect.start' } : { type: 'inspect.stop' })
  }, [inspectMode, nonce])

  if (!iframeUrl) return <div className={`flex size-full items-center justify-center text-sm ${theme('canvas', 'muted')}`}>{t('预览地址尚未就绪')}</div>

  return (
    <div className="relative size-full overflow-hidden">
      <iframe
        allow="clipboard-read; clipboard-write; fullscreen"
        className={`size-full border-0 ${theme('surface')}`}
        ref={iframeRef}
        sandbox={sandbox}
        src={iframeUrl}
        title={t('OpenLink 项目预览')}
      />
      {annotationMode && (
        <div
          aria-label={t('拖动或点击预览以添加批注')}
          className="absolute inset-0 z-20 cursor-crosshair touch-none"
          onPointerCancel={(event) => {
            selectionStart.current = null
            setSelectionRect(null)
            event.currentTarget.releasePointerCapture(event.pointerId)
          }}
          onPointerDown={(event) => {
            if (event.button !== 0) return
            const rect = event.currentTarget.getBoundingClientRect()
            const start = { x: event.clientX - rect.left, y: event.clientY - rect.top }
            selectionStart.current = start
            setSelectionRect({ ...start, width: 0, height: 0 })
            event.currentTarget.setPointerCapture(event.pointerId)
            event.preventDefault()
          }}
          onPointerMove={(event) => {
            const start = selectionStart.current
            if (!start) return
            const rect = event.currentTarget.getBoundingClientRect()
            const end = { x: Math.max(0, Math.min(rect.width, event.clientX - rect.left)), y: Math.max(0, Math.min(rect.height, event.clientY - rect.top)) }
            setSelectionRect({
              x: Math.min(start.x, end.x),
              y: Math.min(start.y, end.y),
              width: Math.abs(end.x - start.x),
              height: Math.abs(end.y - start.y),
            })
          }}
          onPointerUp={(event) => {
            const start = selectionStart.current
            selectionStart.current = null
            setSelectionRect(null)
            if (!start) return
            const rect = event.currentTarget.getBoundingClientRect()
            const end = { x: Math.max(0, Math.min(rect.width, event.clientX - rect.left)), y: Math.max(0, Math.min(rect.height, event.clientY - rect.top)) }
            const safeStart = { x: Math.max(0, Math.min(rect.width, start.x)), y: Math.max(0, Math.min(rect.height, start.y)) }
            const x = Math.round(Math.min(safeStart.x, end.x))
            const y = Math.round(Math.min(safeStart.y, end.y))
            const width = Math.round(Math.abs(end.x - safeStart.x))
            const height = Math.round(Math.abs(end.y - safeStart.y))
            onAnnotationSelect({ x, y, ...(width > 5 && height > 5 ? { width, height } : {}) })
            event.currentTarget.releasePointerCapture(event.pointerId)
          }}
        >
          {selectionRect && <span aria-hidden className="pointer-events-none absolute border border-[var(--app-focus-ring)] bg-[var(--app-focus-ring)]/15" style={selectionRect} />}
          <span className="pointer-events-none absolute left-1/2 top-3 -translate-x-1/2 rounded-full border border-[var(--app-border)] bg-[var(--app-background)]/90 px-3 py-1 text-[11px] text-[var(--app-foreground)] shadow-sm backdrop-blur">{t('点击元素或拖动区域以添加批注')}</span>
        </div>
      )}
    </div>
  )
}
