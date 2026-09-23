'use client'

import {
  BROWSER_PROTOCOL_VERSION,
  INSPECTOR_BRIDGE_CHANNEL,
  isInspectorBridgeEnvelope,
  type ElementReference,
  type InspectorBridgeEnvelope,
  type InspectorBridgeEvent,
} from '@/packages/browser-protocol/src/index'
import { BrowserConnection } from '@/lib/browser-runtime/client'
import { useT } from '@/lib/i18n/client'
import { theme } from '@/lib/theme'
import { useEffect, useMemo, useRef } from 'react'

export function NativePreviewSurface({
  connection,
  inspectMode,
  onElementSelected,
}: {
  connection: BrowserConnection
  inspectMode: boolean
  onElementSelected: (element: ElementReference | null) => void
}) {
  const t = useT()
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const commandIds = useRef(new Map<string, string>())
  const pendingCommands = useRef(new Map<string, InspectorBridgeEnvelope['payload']>())
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
  }, [connection, nonce, onElementSelected])

  useEffect(() => {
    post(inspectMode ? { type: 'inspect.start' } : { type: 'inspect.stop' })
    if (!inspectMode) onElementSelected(null)
  }, [inspectMode, nonce])

  if (!iframeUrl) return <div className={`flex size-full items-center justify-center text-sm ${theme('canvas', 'muted')}`}>{t('预览地址尚未就绪')}</div>

  return (
    <iframe
      allow="clipboard-read; clipboard-write; fullscreen"
      className={`size-full border-0 ${theme('surface')}`}
      ref={iframeRef}
      sandbox={sandbox}
      src={iframeUrl}
      title={t('OpenLink 项目预览')}
    />
  )
}
