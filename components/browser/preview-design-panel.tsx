'use client'

import type { BrowserElementMove, BrowserPreviewAnnotationTarget, BrowserWorkbenchHandle, BrowserWorkbenchUiState } from '@/components/browser/browser-workbench'
import type { AgentPromptAttachment } from '@/lib/agent-runtime/events'
import { useT } from '@/lib/i18n/client'
import { isPreviewTargetId } from '@/lib/browser-preview-target-id'
import { previewPagePathFromAddress, sanitizePreviewPagePath, type ElementReference } from '@/packages/browser-protocol/src/index'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { AppWindow, Eye, Layers3, LoaderCircle, MessageSquarePlus, Palette, RotateCw, Undo2, Redo2, WandSparkles, X } from 'lucide-react'
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'

type PreviewPanelTab = 'edit' | 'theme' | 'layers' | 'annotations'
type PreviewEdit = {
  key: string
  kind: 'style' | 'theme' | 'content'
  ref: string
  property: string
  selector: string
  label: string
  before: string
  after: string
}

interface PreviewAnnotation {
  id: string
  target_id: string
  page_path: string
  element_selector: string | null
  element_label: string | null
  bounds: { x: number; y: number; width: number; height: number }
  viewport: { width: number; height: number }
  comment: string
  screenshot_data_url?: string
}

export type PreviewAnnotationMarker = Pick<PreviewAnnotation, 'id' | 'page_path' | 'element_label' | 'bounds' | 'viewport'>
export interface PreviewProjectOption { id: string; name: string }

interface AnnotationDraft {
  id: string
  targetId: string
  pagePath: string
  selector?: string
  label?: string
  bounds: { x: number; y: number; width: number; height: number }
  viewport: { width: number; height: number }
  screenshotDataUrl?: string
  capturing: boolean
}

interface DesignScreenshotContext {
  projectId: string
  targetId: string
  pagePath: string
  elementRef: string
  selector?: string
  elementLabel?: string
  elementText?: string
  viewport?: { width: number; height: number }
  fullViewportDataUrl?: string
  selectedElementDataUrl?: string
  capturing: boolean
  error?: string
}

export interface PreviewDesignPanelHandle {
  handleElementMoved: (move: BrowserElementMove) => void
  handleAnnotationTarget: (target: BrowserPreviewAnnotationTarget) => void
  showAnnotation: (annotationId: string) => void
}

interface PreviewDesignPanelProps {
  browserState: BrowserWorkbenchUiState
  workbenchRef: React.RefObject<BrowserWorkbenchHandle | null>
  projectId: string
  previewProjects: PreviewProjectOption[]
  selectedPreviewProjectId: string
  onSelectPreviewProject: (projectId: string) => void
  sessionId: string
  className?: string
  onSubmitRequest: (message: string, attachments: AgentPromptAttachment[], projectId: string) => Promise<boolean>
  onAnnotationsChange: (annotations: PreviewAnnotationMarker[]) => void
}

const STYLE_PROPERTIES = [
  'color', 'background-color', 'font-family', 'font-size', 'font-style', 'font-weight', 'letter-spacing',
  'line-height', 'text-align', 'text-decoration', 'text-decoration-color', 'text-indent', 'text-transform', 'word-spacing',
  'width', 'min-width', 'max-width', 'height', 'margin', 'padding', 'gap', 'border-radius', 'border-color',
  'border-width', 'opacity', 'display', 'position', 'justify-content', 'align-items', 'flex-direction', 'box-shadow', 'translate',
]
const COLOR_PROPERTIES = new Set(['color', 'background-color', 'border-color', 'text-decoration-color'])

function screenshotDataUrl(data: string) {
  return `data:image/jpeg;base64,${data}`
}

async function cropPreviewScreenshot(dataUrl: string, bounds: ElementReference['bounds'], viewport: { width: number; height: number }) {
  const image = new Image()
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve()
    image.onerror = () => reject(new Error('Could not decode the Preview screenshot'))
    image.src = dataUrl
  })
  const scaleX = image.naturalWidth / viewport.width
  const scaleY = image.naturalHeight / viewport.height
  const padding = 24
  const left = Math.max(0, Math.floor((bounds.x - padding) * scaleX))
  const top = Math.max(0, Math.floor((bounds.y - padding) * scaleY))
  const right = Math.min(image.naturalWidth, Math.ceil((bounds.x + bounds.width + padding) * scaleX))
  const bottom = Math.min(image.naturalHeight, Math.ceil((bounds.y + bounds.height + padding) * scaleY))
  if (right <= left || bottom <= top) throw new Error('The selected element is outside the captured viewport')
  const canvas = document.createElement('canvas')
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Could not crop the selected Preview element')
  for (const scale of [1, 0.8, 0.64, 0.5, 0.4]) {
    canvas.width = Math.max(1, Math.round((right - left) * scale))
    canvas.height = Math.max(1, Math.round((bottom - top) * scale))
    context.drawImage(image, left, top, right - left, bottom - top, 0, 0, canvas.width, canvas.height)
    const result = canvas.toDataURL('image/jpeg', 0.82)
    if (result.length <= 2_800_000) return result
  }
  throw new Error('The selected element screenshot is too large to attach')
}

function colorPickerValue(value: string): string | null {
  if (typeof document === 'undefined' || !value || !CSS.supports('color', value)) return null
  const context = document.createElement('canvas').getContext('2d')
  if (!context) return null
  context.fillStyle = '#000000'
  context.fillStyle = value
  const normalized = context.fillStyle
  const hex = /^#([\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i.exec(normalized)?.[1]
  if (hex) {
    const expanded = hex.length < 5 ? hex.split('').map((part) => part + part).join('') : hex
    return `#${expanded.slice(0, 6)}`
  }
  const rgb = /^rgba?\((.*)\)$/i.exec(normalized)?.[1]
  if (!rgb) return null
  const channels = rgb.split(/[,/\s]+/).filter(Boolean).slice(0, 3).map((part) => {
    const parsed = part.endsWith('%') ? Number.parseFloat(part) * 2.55 : Number.parseFloat(part)
    return Number.isFinite(parsed) ? Math.max(0, Math.min(255, Math.round(parsed))) : null
  })
  if (channels.length !== 3 || channels.some((channel) => channel === null)) return null
  return `#${channels.map((channel) => channel!.toString(16).padStart(2, '0')).join('')}`
}

function safePreviewPagePath(address: string): string {
  return previewPagePathFromAddress(address)
    ?? sanitizePreviewPagePath(address)
    ?? '/'
}

export const PreviewDesignPanel = forwardRef<PreviewDesignPanelHandle, PreviewDesignPanelProps>(function PreviewDesignPanel({
  browserState,
  workbenchRef,
  projectId,
  previewProjects,
  selectedPreviewProjectId,
  onSelectPreviewProject,
  sessionId,
  className = '',
  onSubmitRequest,
  onAnnotationsChange,
}, forwardedRef) {
  const t = useT()
  const [panelTab, setPanelTab] = useState<PreviewPanelTab>('edit')
  const [pendingEdits, setPendingEdits] = useState<PreviewEdit[]>([])
  const [undoStack, setUndoStack] = useState<PreviewEdit[][]>([])
  const [redoStack, setRedoStack] = useState<PreviewEdit[][]>([])
  const [showingBefore, setShowingBefore] = useState(false)
  const [styleDrafts, setStyleDrafts] = useState<Record<string, string>>({})
  const [themeDrafts, setThemeDrafts] = useState<Record<string, string>>({})
  const [contentDraft, setContentDraft] = useState('')
  const [designScreenshot, setDesignScreenshot] = useState<DesignScreenshotContext | null>(null)
  const [designScreenshotRetry, setDesignScreenshotRetry] = useState(0)
  const [applyError, setApplyError] = useState<string | null>(null)
  const [annotations, setAnnotations] = useState<PreviewAnnotation[]>([])
  const [annotationDraft, setAnnotationDraft] = useState<AnnotationDraft | null>(null)
  const [annotationComment, setAnnotationComment] = useState('')
  const [annotationError, setAnnotationError] = useState<string | null>(null)
  const [annotationBusy, setAnnotationBusy] = useState(false)
  const [screenshotLoadingId, setScreenshotLoadingId] = useState<string | null>(null)
  const [expandedAnnotationId, setExpandedAnnotationId] = useState<string | null>(null)
  const [annotationSelection, setAnnotationSelection] = useState<string[]>([])
  const [sendingAnnotations, setSendingAnnotations] = useState(false)
  const selectedElementRef = browserState.selectedElement?.ref
  const pagePath = safePreviewPagePath(browserState.address)
  const targetId = browserState.activePreviewTargetId
  const selectedViewport = {
    width: browserState.selectedElement?.viewport?.width ?? 1280,
    height: browserState.selectedElement?.viewport?.height ?? 800,
  }
  const selectedElementRefData = useRef(browserState.selectedElement ?? null)
  selectedElementRefData.current = browserState.selectedElement ?? null

  useEffect(() => {
    setContentDraft(browserState.selectedElement?.content ?? '')
  }, [browserState.selectedElement?.content, browserState.selectedElement?.ref])

  useEffect(() => {
    if (browserState.themeTokens) setThemeDrafts(browserState.themeTokens)
  }, [browserState.themeTokens])

  useEffect(() => {
    if (panelTab === 'theme') workbenchRef.current?.readThemeTokens()
    if (panelTab === 'layers') workbenchRef.current?.readLayers()
  }, [panelTab, workbenchRef])

  useEffect(() => {
    setPendingEdits([])
    setUndoStack([])
    setRedoStack([])
    setShowingBefore(false)
    setStyleDrafts({})
    setThemeDrafts({})
    setDesignScreenshot(null)
    setAnnotationDraft(null)
    setAnnotations([])
    setAnnotationSelection([])
    setExpandedAnnotationId(null)
  }, [projectId, sessionId, targetId, pagePath])

  useEffect(() => {
    const element = selectedElementRefData.current
    if (!projectId || !isPreviewTargetId(targetId) || !element) return
    const viewport = {
      width: Math.max(240, Math.min(2560, Math.round(selectedViewport.width))),
      height: Math.max(240, Math.min(4320, Math.round(selectedViewport.height))),
    }
    const controller = new AbortController()
    let cancelled = false
    setDesignScreenshot({ projectId, targetId, pagePath, elementRef: element.ref, capturing: true })
    void fetch('/api/browser/preview-screenshot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId, previewTargetId: targetId, pagePath, viewport: { ...viewport, deviceScaleFactor: 1 } }),
      signal: controller.signal,
    }).then(async (response) => {
      const payload = await response.json().catch(() => null) as { image?: { mimeType?: unknown; data?: unknown }; error?: { message?: string } } | null
      if (!response.ok || payload?.image?.mimeType !== 'image/jpeg' || typeof payload.image.data !== 'string'
        || payload.image.data.length > 2_800_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(payload.image.data)) {
        throw new Error(payload?.error?.message || t('Capture failed; retry to attach element context'))
      }
      const fullViewportDataUrl = screenshotDataUrl(payload.image.data)
      const selectedElementDataUrl = await cropPreviewScreenshot(fullViewportDataUrl, element.bounds, viewport)
      if (!cancelled) setDesignScreenshot({
        projectId,
        targetId,
        pagePath,
        elementRef: element.ref,
        selector: element.selector,
        elementLabel: element.componentName || element.text || element.tagName,
        elementText: element.content ?? element.text,
        viewport,
        fullViewportDataUrl,
        selectedElementDataUrl,
        capturing: false,
      })
    }).catch((error) => {
      if (cancelled || (error instanceof DOMException && error.name === 'AbortError')) return
      setDesignScreenshot({
        projectId,
        targetId,
        pagePath,
        elementRef: element.ref,
        selector: element.selector,
        elementLabel: element.componentName || element.text || element.tagName,
        elementText: element.content ?? element.text,
        viewport,
        capturing: false,
        error: error instanceof Error ? error.message : t('Capture failed; retry to attach element context'),
      })
    })
    return () => { cancelled = true; controller.abort() }
  }, [designScreenshotRetry, pagePath, projectId, selectedElementRef, selectedViewport.height, selectedViewport.width, t, targetId])

  useEffect(() => {
    if (!projectId || !isPreviewTargetId(targetId)) {
      setAnnotations([])
      setAnnotationSelection([])
      return
    }
    let cancelled = false
    setAnnotations([])
    setAnnotationSelection([])
    setAnnotationDraft(null)
    setExpandedAnnotationId(null)
    setAnnotationError(null)
    void fetch(`/api/browser/preview-annotations?projectId=${encodeURIComponent(projectId)}&targetId=${encodeURIComponent(targetId)}`, { cache: 'no-store' })
      .then(async (response) => {
        const payload = await response.json().catch(() => null) as { annotations?: unknown; error?: { message?: string } } | null
        if (!response.ok) throw new Error(payload?.error?.message || t('无法读取批注'))
        return Array.isArray(payload?.annotations) ? payload.annotations as PreviewAnnotation[] : []
      })
      .then((items) => { if (!cancelled) { setAnnotations(items); setAnnotationSelection(items.slice(0, 4).map((item) => item.id)) } })
      .catch((error) => { if (!cancelled) setAnnotationError(error instanceof Error ? error.message : t('无法读取批注')) })
    return () => { cancelled = true }
  }, [projectId, t, targetId])

  useEffect(() => {
    onAnnotationsChange(annotations
      .filter((annotation) => annotation.page_path === pagePath)
      .map(({ id, page_path, element_label, bounds, viewport }) => ({ id, page_path, element_label, bounds, viewport })))
  }, [annotations, onAnnotationsChange, pagePath])

  const pushEditSnapshot = useCallback((next: PreviewEdit[]) => {
    setUndoStack((stack) => [...stack.slice(-29), pendingEdits])
    setRedoStack([])
    setPendingEdits(next)
    setShowingBefore(false)
  }, [pendingEdits])

  const updateStyle = useCallback((property: string, value: string) => {
    const element = browserState.selectedElement
    if (!element || showingBefore) return
    const key = `style:${element.ref}:${property}`
    const existing = pendingEdits.find((edit) => edit.key === key)
    const before = existing?.before ?? browserState.selectedStyles?.[property] ?? ''
    const next = pendingEdits.filter((edit) => edit.key !== key)
    const changed = value.trim() !== before.trim()
    if (changed) next.push({ key, kind: 'style', ref: element.ref, property, selector: element.selector || element.tagName, label: element.componentName || element.text || element.tagName, before, after: value })
    pushEditSnapshot(next)
    if (changed) workbenchRef.current?.setElementStyle(element.ref, property, value)
    else workbenchRef.current?.resetElementStyle(element.ref, property)
  }, [browserState.selectedElement, browserState.selectedStyles, pendingEdits, pushEditSnapshot, showingBefore, workbenchRef])

  const updateContent = useCallback((value: string) => {
    const element = browserState.selectedElement
    if (!element?.canEditContent || showingBefore) return
    const key = `content:${element.ref}`
    const existing = pendingEdits.find((edit) => edit.key === key)
    const before = existing?.before ?? element.content ?? ''
    const next = pendingEdits.filter((edit) => edit.key !== key)
    if (value !== before) next.push({ key, kind: 'content', ref: element.ref, property: 'text content', selector: element.selector || element.tagName, label: element.componentName || element.text || element.tagName, before, after: value })
    pushEditSnapshot(next)
    if (value !== before) workbenchRef.current?.setElementContent(element.ref, value)
    else workbenchRef.current?.resetElementContent(element.ref)
  }, [browserState.selectedElement, pendingEdits, pushEditSnapshot, showingBefore, workbenchRef])

  const handleElementMoved = useCallback((move: BrowserElementMove) => {
    const key = `style:${move.element.ref}:${move.property}`
    const existing = pendingEdits.find((edit) => edit.key === key)
    const before = existing?.before ?? move.before
    const next = pendingEdits.filter((edit) => edit.key !== key)
    if (move.after !== before) next.push({ key, kind: 'style', ref: move.element.ref, property: move.property, selector: move.element.selector || move.element.tagName, label: move.element.componentName || move.element.text || move.element.tagName, before, after: move.after })
    setStyleDrafts((current) => ({ ...current, [move.property]: move.after }))
    pushEditSnapshot(next)
  }, [pendingEdits, pushEditSnapshot])

  const updateThemeToken = useCallback((token: string, value: string) => {
    if (showingBefore) return
    const key = `theme:${token}`
    const existing = pendingEdits.find((edit) => edit.key === key)
    const before = existing?.before ?? browserState.themeTokens?.[token] ?? ''
    const next = pendingEdits.filter((edit) => edit.key !== key)
    const changed = value.trim() !== before.trim()
    if (changed) next.push({ key, kind: 'theme', ref: 'root', property: token, selector: ':root', label: token, before, after: value })
    pushEditSnapshot(next)
    if (changed) workbenchRef.current?.setThemeToken(token, value)
    else workbenchRef.current?.resetThemeToken(token)
  }, [browserState.themeTokens, pendingEdits, pushEditSnapshot, showingBefore, workbenchRef])

  const applyEditSnapshot = useCallback((from: PreviewEdit[], to: PreviewEdit[]) => {
    const fromByKey = new Map(from.map((edit) => [edit.key, edit]))
    const toByKey = new Map(to.map((edit) => [edit.key, edit]))
    for (const key of new Set([...fromByKey.keys(), ...toByKey.keys()])) {
      const previous = fromByKey.get(key)
      const next = toByKey.get(key)
      if (next) {
        if (next.kind === 'style') workbenchRef.current?.setElementStyle(next.ref, next.property, next.after)
        else if (next.kind === 'content') workbenchRef.current?.setElementContent(next.ref, next.after)
        else workbenchRef.current?.setThemeToken(next.property, next.after)
      } else if (previous?.kind === 'style') workbenchRef.current?.resetElementStyle(previous.ref, previous.property)
      else if (previous?.kind === 'content') workbenchRef.current?.resetElementContent(previous.ref)
      else if (previous) workbenchRef.current?.resetThemeToken(previous.property)
    }
    setPendingEdits(to)
    setShowingBefore(false)
  }, [workbenchRef])

  const undoEdit = useCallback(() => {
    const previous = undoStack.at(-1)
    if (!previous) return
    setRedoStack((stack) => [...stack, pendingEdits])
    setUndoStack((stack) => stack.slice(0, -1))
    applyEditSnapshot(pendingEdits, previous)
  }, [applyEditSnapshot, pendingEdits, undoStack])

  const redoEdit = useCallback(() => {
    const next = redoStack.at(-1)
    if (!next) return
    setUndoStack((stack) => [...stack, pendingEdits])
    setRedoStack((stack) => stack.slice(0, -1))
    applyEditSnapshot(pendingEdits, next)
  }, [applyEditSnapshot, pendingEdits, redoStack])

  const toggleBeforeAfter = useCallback(() => {
    const showBefore = !showingBefore
    for (const edit of pendingEdits) {
      if (edit.kind === 'style') workbenchRef.current?.setElementStyle(edit.ref, edit.property, showBefore ? edit.before : edit.after)
      else if (edit.kind === 'content') workbenchRef.current?.setElementContent(edit.ref, showBefore ? edit.before : edit.after)
      else workbenchRef.current?.setThemeToken(edit.property, showBefore ? edit.before : edit.after)
    }
    setShowingBefore(showBefore)
  }, [pendingEdits, showingBefore, workbenchRef])

  const resetDesign = useCallback(() => {
    for (const edit of pendingEdits) {
      if (edit.kind === 'style') workbenchRef.current?.resetElementStyle(edit.ref, edit.property)
      else if (edit.kind === 'content') workbenchRef.current?.resetElementContent(edit.ref)
      else workbenchRef.current?.resetThemeToken(edit.property)
    }
    setPendingEdits([])
    setUndoStack([])
    setRedoStack([])
    setShowingBefore(false)
  }, [pendingEdits, workbenchRef])

  const usableDesignScreenshot = Boolean(designScreenshot
    && designScreenshot.projectId === projectId
    && designScreenshot.targetId === targetId
    && designScreenshot.pagePath === pagePath
    && (!browserState.selectedElement || designScreenshot.elementRef === browserState.selectedElement.ref)
    && !designScreenshot.capturing
    && designScreenshot.fullViewportDataUrl
    && designScreenshot.selectedElementDataUrl)

  const applyDesignChanges = useCallback(async () => {
    if (!pendingEdits.length || !targetId || showingBefore) return
    const screenshotIsCurrent = usableDesignScreenshot
    const needsElementContext = pendingEdits.some((edit) => edit.kind === 'style' || edit.kind === 'content')
    if (needsElementContext && !screenshotIsCurrent) {
      setApplyError(t('Capture failed; retry to attach element context'))
      return
    }
    setApplyError(null)
    const changeList = pendingEdits.map((edit) => `- ${edit.selector} (${edit.label}): ${edit.property} ${edit.before || '(default)'} -> ${edit.after}`).join('\n')
    const prompt = [
      'Apply these visual changes to the editable source code for the current project.',
      `Preview page: ${pagePath}`,
      `Preview target: ${browserState.previewTargets.find((target) => target.id === targetId)?.label || 'the active project preview'}`,
      screenshotIsCurrent ? `Preview viewport: ${designScreenshot?.viewport?.width ?? 'unknown'}×${designScreenshot?.viewport?.height ?? 'unknown'} CSS pixels.` : '',
      screenshotIsCurrent ? 'Image 1 shows the full Preview viewport. Image 2 is a crop around the selected element. Use both as visual context.' : '',
      screenshotIsCurrent && designScreenshot?.selector ? `Selected element: ${designScreenshot.selector}${designScreenshot.elementLabel ? ` (${designScreenshot.elementLabel})` : ''}.` : '',
      screenshotIsCurrent && designScreenshot?.elementText ? `Selected element text: ${designScreenshot.elementText.slice(0, 500)}` : '',
      'Treat selectors, content, and styles as visual guidance. Find the responsible source components, make the smallest appropriate code changes, and leave a reviewable diff. Do not commit changes.',
      'Requested changes:',
      changeList,
    ].filter(Boolean).join('\n')
    if (prompt.length > 9500) {
      setApplyError(t('Design instructions are too long. Apply fewer changes.'))
      return
    }
    try {
      const attachments: AgentPromptAttachment[] = screenshotIsCurrent ? [
        { type: 'image', mediaType: 'image/jpeg', url: designScreenshot!.fullViewportDataUrl!, filename: 'preview-viewport.jpg' },
        { type: 'image', mediaType: 'image/jpeg', url: designScreenshot!.selectedElementDataUrl!, filename: 'preview-selection.jpg' },
      ] : []
      const accepted = await onSubmitRequest(prompt, attachments, projectId)
      if (!accepted) setApplyError(t('Could not send design changes.'))
    } catch (error) {
      setApplyError(error instanceof Error ? error.message : t('Could not send design changes.'))
    }
  }, [browserState.previewTargets, designScreenshot, onSubmitRequest, pagePath, pendingEdits, projectId, showingBefore, t, targetId, usableDesignScreenshot])

  const handleAnnotationTarget = useCallback((target: BrowserPreviewAnnotationTarget) => {
    if (!isPreviewTargetId(targetId)) {
      setAnnotationError(t('请先选择一个预览目标'))
      return
    }
    const id = crypto.randomUUID()
    setAnnotationError(null)
    setAnnotationComment('')
    setPanelTab('annotations')
    const viewport = target.viewport
    const draft: AnnotationDraft = {
      id,
      targetId,
      pagePath: target.pagePath,
      ...(target.element?.selector ? { selector: target.element.selector } : {}),
      ...(target.element ? { label: target.element.componentName || target.element.text || target.element.tagName } : {}),
      bounds: target.bounds,
      viewport,
      capturing: true,
    }
    setAnnotationDraft(draft)
    void fetch('/api/browser/preview-screenshot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId, previewTargetId: targetId, pagePath: target.pagePath, viewport: { ...viewport, deviceScaleFactor: 1 } }),
    }).then(async (response) => {
      const payload = await response.json().catch(() => null) as { image?: { mimeType?: unknown; data?: unknown }; error?: { message?: string } } | null
      if (!response.ok || payload?.image?.mimeType !== 'image/jpeg' || typeof payload.image.data !== 'string') {
        throw new Error(payload?.error?.message || t('无法为批注捕获截图'))
      }
      setAnnotationDraft((current) => current?.id === id ? { ...current, screenshotDataUrl: screenshotDataUrl(payload.image!.data as string), capturing: false } : current)
    }).catch((error) => {
      setAnnotationDraft((current) => current?.id === id ? { ...current, capturing: false } : current)
      setAnnotationError(error instanceof Error ? error.message : t('无法为批注捕获截图'))
    })
  }, [projectId, t, targetId])

  const saveAnnotation = useCallback(async () => {
    if (!annotationDraft?.screenshotDataUrl || !annotationComment.trim() || annotationBusy) return
    setAnnotationBusy(true)
    setAnnotationError(null)
    try {
      const response = await fetch('/api/browser/preview-annotations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId,
          annotationId: annotationDraft.id,
          targetId: annotationDraft.targetId,
          pagePath: annotationDraft.pagePath,
          selector: annotationDraft.selector,
          label: annotationDraft.label,
          bounds: annotationDraft.bounds,
          viewport: annotationDraft.viewport,
          comment: annotationComment,
          screenshotDataUrl: annotationDraft.screenshotDataUrl,
        }),
      })
      const payload = await response.json().catch(() => null) as { annotation?: PreviewAnnotation; error?: { message?: string } } | null
      if (!response.ok || !payload?.annotation) throw new Error(payload?.error?.message || t('保存批注失败'))
      setAnnotations((current) => [...current, { ...payload.annotation!, screenshot_data_url: annotationDraft.screenshotDataUrl }])
      setAnnotationSelection((current) => current.length < 4 ? [...current, payload.annotation!.id] : current)
      setAnnotationDraft(null)
      setAnnotationComment('')
    } catch (error) {
      setAnnotationError(error instanceof Error ? error.message : t('保存批注失败'))
    } finally {
      setAnnotationBusy(false)
    }
  }, [annotationBusy, annotationComment, annotationDraft, projectId, t])

  const loadAnnotationScreenshot = useCallback(async (annotation: PreviewAnnotation) => {
    if (annotation.screenshot_data_url) return annotation.screenshot_data_url
    setScreenshotLoadingId(annotation.id)
    try {
      const response = await fetch(`/api/browser/preview-annotations/${encodeURIComponent(annotation.id)}/screenshot?projectId=${encodeURIComponent(projectId)}`, { cache: 'no-store' })
      const payload = await response.json().catch(() => null) as { screenshotDataUrl?: unknown; error?: { message?: string } } | null
      if (!response.ok || typeof payload?.screenshotDataUrl !== 'string'
        || !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(payload.screenshotDataUrl)
        || payload.screenshotDataUrl.length > 2_800_050) throw new Error(payload?.error?.message || t('无法读取批注截图'))
      setAnnotations((current) => current.map((item) => item.id === annotation.id ? { ...item, screenshot_data_url: payload.screenshotDataUrl as string } : item))
      return payload.screenshotDataUrl
    } finally {
      setScreenshotLoadingId((current) => current === annotation.id ? null : current)
    }
  }, [projectId, t])

  const sendAnnotationBatch = useCallback(async () => {
    if (!annotationSelection.length || sendingAnnotations) return
    setSendingAnnotations(true)
    setAnnotationError(null)
    try {
      const selected = annotations.filter((annotation) => annotationSelection.includes(annotation.id))
      const selectedWithScreenshots = await Promise.all(selected.map(async (annotation) => ({ annotation, screenshotDataUrl: await loadAnnotationScreenshot(annotation) })))
      const prompt = [
        'Review the attached Preview annotations and update the current project code to address them.',
        'Use each screenshot as visual context. Keep the changes scoped to the comments and leave a reviewable source diff.',
        ...selectedWithScreenshots.map(({ annotation }, index) => [
          `${index + 1}. Page ${annotation.page_path}${annotation.element_label ? ` — ${annotation.element_label}` : ''}`,
          annotation.element_selector ? `   Selector: ${annotation.element_selector.slice(0, 300)}` : '',
          `   Region: x=${Math.round(annotation.bounds.x)}, y=${Math.round(annotation.bounds.y)}, width=${Math.round(annotation.bounds.width)}, height=${Math.round(annotation.bounds.height)} of ${annotation.viewport.width}×${annotation.viewport.height}`,
          `   Comment: ${annotation.comment.slice(0, 1800)}`,
        ].filter(Boolean).join('\n')),
      ].join('\n\n')
      if (prompt.length > 9500) throw new Error(t('所选批注内容过长，请分批发送'))
      const attachments: AgentPromptAttachment[] = selectedWithScreenshots.map(({ annotation, screenshotDataUrl: image }, index) => ({
        type: 'image', mediaType: 'image/jpeg', url: image, filename: `preview-annotation-${index + 1}.jpg`,
      }))
      const accepted = await onSubmitRequest(prompt, attachments, projectId)
      if (!accepted) throw new Error(t('发送批注失败'))
    } catch (error) {
      setAnnotationError(error instanceof Error ? error.message : t('发送批注失败'))
    } finally {
      setSendingAnnotations(false)
    }
  }, [annotationSelection, annotations, loadAnnotationScreenshot, onSubmitRequest, projectId, sendingAnnotations, t])

  const toggleAnnotationForChat = useCallback((id: string, checked: boolean) => {
    setAnnotationSelection((current) => {
      if (!checked) return current.filter((value) => value !== id)
      return current.length < 4 && !current.includes(id) ? [...current, id] : current
    })
  }, [])

  const showAnnotation = useCallback((annotationId: string) => {
    if (!annotations.some((annotation) => annotation.id === annotationId)) return
    setPanelTab('annotations')
    setExpandedAnnotationId(annotationId)
  }, [annotations])

  useImperativeHandle(forwardedRef, () => ({ handleElementMoved, handleAnnotationTarget, showAnnotation }), [handleAnnotationTarget, handleElementMoved, showAnnotation])

  const tabs: Array<[PreviewPanelTab, string, typeof WandSparkles]> = [
    ['edit', 'Edit', WandSparkles], ['theme', 'Theme', Palette], ['layers', '图层', Layers3], ['annotations', 'Annotate', MessageSquarePlus],
  ]
  const selectedElement = browserState.selectedElement

  return (
    <aside aria-label={t('预览工具')} className={`flex h-full w-[280px] shrink-0 flex-col border-l border-[var(--app-border)] bg-[var(--app-background)] text-xs text-[var(--app-muted)] max-[720px]:absolute max-[720px]:inset-y-0 max-[720px]:right-0 max-[720px]:z-40 max-[720px]:w-[252px] max-[720px]:shadow-xl ${className}`}>
      <div className="grid h-[60px] shrink-0 grid-cols-4 border-b border-[var(--app-border)]">
        {tabs.map(([tab, label, Icon]) => (
          <button aria-pressed={panelTab === tab} className={`flex flex-col items-center justify-center gap-1 border-b-2 text-[10px] ${panelTab === tab ? 'border-[var(--app-foreground)] text-[var(--app-foreground)]' : 'border-transparent text-[var(--app-muted)] hover:text-[var(--app-foreground)]'}`} key={tab} onClick={() => setPanelTab(tab)} type="button">
            <Icon className="size-4" strokeWidth={1.7} />{t(label)}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        {panelTab === 'edit' && (
          selectedElement ? (
            <div className="space-y-3">
              <div className="rounded-md border border-[var(--app-control-border)] p-2">
                <p className="truncate font-medium text-[var(--app-foreground)]">{selectedElement.componentName || selectedElement.tagName}</p>
                <p className="mt-0.5 truncate font-mono text-[10px]" title={selectedElement.selector}>{selectedElement.selector}</p>
              </div>
              <p>{t('Hold Ctrl or ⌘ and drag to move the selected element.')}</p>
              {designScreenshot && designScreenshot.elementRef === selectedElement.ref && (
                <div className="space-y-1.5 rounded-md border border-[var(--app-control-border)] p-2">
                  <p className="font-medium text-[var(--app-foreground)]">{t('Selected element screenshot')}</p>
                  {designScreenshot.capturing && <p className="flex items-center gap-1.5"><LoaderCircle className="size-3 animate-spin" />{t('Capturing selected element context…')}</p>}
                  {designScreenshot.error && <div className="space-y-1.5"><p className="text-[var(--app-danger)]">{designScreenshot.error}</p><button className="h-6 rounded border border-[var(--app-control-border)] px-2 hover:bg-[var(--app-hover)]" onClick={() => setDesignScreenshotRetry((retry) => retry + 1)} type="button">{t('Retry screenshot')}</button></div>}
                  {usableDesignScreenshot && <div className="grid grid-cols-2 gap-1.5">
                    <div className="min-w-0"><p className="mb-1 text-[10px]">{t('Full viewport context')}</p><img alt={t('Full viewport context')} className="h-20 w-full rounded border border-[var(--app-border)] bg-[var(--app-surface)] object-contain" src={designScreenshot.fullViewportDataUrl} /></div>
                    <div className="min-w-0"><p className="mb-1 text-[10px]">{t('Selected element screenshot')}</p><img alt={t('Selected element screenshot')} className="h-20 w-full rounded border border-[var(--app-border)] bg-[var(--app-surface)] object-contain" src={designScreenshot.selectedElementDataUrl} /></div>
                  </div>}
                </div>
              )}
              {selectedElement.canEditContent ? <label className="block space-y-1.5"><span className="font-medium text-[var(--app-foreground)]">{t('Text content')}</span><textarea className="min-h-16 w-full resize-y rounded border border-[var(--app-control-border)] bg-[var(--app-surface)] p-2 text-xs text-[var(--app-foreground)] outline-none focus:border-[var(--app-focus-ring)] disabled:opacity-50" disabled={showingBefore} maxLength={2000} onChange={(event) => { const value = event.currentTarget.value; setContentDraft(value); updateContent(value) }} value={contentDraft} /></label> : <p>{t('This element does not support text editing.')}</p>}
              <div className="flex items-center gap-1">
                <button aria-label={t('Undo')} className="flex size-7 items-center justify-center rounded border border-[var(--app-control-border)] disabled:opacity-35" disabled={!undoStack.length} onClick={undoEdit} type="button"><Undo2 className="size-3.5" /></button>
                <button aria-label={t('Redo')} className="flex size-7 items-center justify-center rounded border border-[var(--app-control-border)] disabled:opacity-35" disabled={!redoStack.length} onClick={redoEdit} type="button"><Redo2 className="size-3.5" /></button>
                <button className="ml-auto flex h-7 items-center gap-1 rounded border border-[var(--app-control-border)] px-2 text-[10px] disabled:opacity-35" disabled={!pendingEdits.length} onClick={toggleBeforeAfter} type="button"><Eye className="size-3" />{showingBefore ? t('Show after') : t('Before / after')}</button>
              </div>
              <div className="space-y-2">
                {STYLE_PROPERTIES.map((property) => (
                  <label className="grid grid-cols-[94px_minmax(0,1fr)] items-center gap-2" key={property}>
                    <span className="truncate font-mono text-[10px]">{property}</span>
                    <span className="flex min-w-0 items-center gap-1">
                      {COLOR_PROPERTIES.has(property) && <input aria-label={`${t('Choose color')}: ${property}`} className="size-7 shrink-0 rounded border border-[var(--app-control-border)] bg-[var(--app-surface)] p-0.5 disabled:opacity-50" disabled={showingBefore || !browserState.selectedStyles} onChange={(event) => { const value = event.currentTarget.value; setStyleDrafts((current) => ({ ...current, [property]: value })); updateStyle(property, value) }} type="color" value={colorPickerValue(styleDrafts[property] ?? browserState.selectedStyles?.[property] ?? '') ?? '#000000'} />}
                      <input className="h-7 min-w-0 flex-1 rounded border border-[var(--app-control-border)] bg-[var(--app-surface)] px-2 font-mono text-[10px] text-[var(--app-foreground)] outline-none focus:border-[var(--app-focus-ring)] disabled:opacity-50" disabled={showingBefore || !browserState.selectedStyles} onChange={(event) => { const value = event.currentTarget.value; setStyleDrafts((current) => ({ ...current, [property]: value })); updateStyle(property, value) }} value={styleDrafts[property] ?? browserState.selectedStyles?.[property] ?? ''} />
                    </span>
                  </label>
                ))}
              </div>
              {pendingEdits.length > 0 && <div className="space-y-2 border-t border-[var(--app-border)] pt-3">
                <p>{t('{count} pending changes', { count: pendingEdits.length })}</p>
                {applyError && <p className="text-[var(--app-danger)]">{applyError}</p>}
                <div className="flex gap-2">
                  <button className="h-7 flex-1 rounded border border-[var(--app-control-border)] hover:bg-[var(--app-hover)]" onClick={resetDesign} type="button">{t('Reset')}</button>
                  <button className="flex h-7 flex-1 items-center justify-center gap-1 rounded bg-[var(--app-submit-background)] px-2 font-medium text-[var(--app-submit-foreground)] disabled:opacity-45" disabled={showingBefore || (pendingEdits.some((edit) => edit.kind !== 'theme') && !usableDesignScreenshot)} onClick={() => void applyDesignChanges()} type="button"><WandSparkles className="size-3" />{t('Apply changes')}</button>
                </div>
              </div>}
            </div>
          ) : (
            <div className="space-y-3 py-4 text-center">
              <WandSparkles className="mx-auto size-5" />
              <p>{t('点击预览中的元素以查看和调整样式。')}</p>
              <button className="h-7 rounded border border-[var(--app-control-border)] px-3 text-[var(--app-foreground)] hover:bg-[var(--app-hover)] disabled:opacity-40" disabled={!browserState.canInspect} onClick={() => workbenchRef.current?.setInspectionMode('edit')} type="button">{t('选择组件')}</button>
            </div>
          )
        )}
        {panelTab === 'theme' && <div className="space-y-2">
          <p className="mb-3">{t('主题颜色来自当前页面可用的 CSS 变量。修改会暂时应用到预览。')}</p>
          {Object.entries(browserState.themeTokens ?? {}).map(([token, currentValue]) => (
            <label className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] items-center gap-2" key={token}>
              <span className="truncate font-mono text-[10px]" title={token}>{token}</span>
              <span className="flex min-w-0 items-center gap-1">
                {colorPickerValue(themeDrafts[token] ?? currentValue) && <input aria-label={`${t('Choose color')}: ${token}`} className="size-7 shrink-0 rounded border border-[var(--app-control-border)] bg-[var(--app-surface)] p-0.5" onChange={(event) => { const value = event.currentTarget.value; setThemeDrafts((current) => ({ ...current, [token]: value })); updateThemeToken(token, value) }} type="color" value={colorPickerValue(themeDrafts[token] ?? currentValue) ?? '#000000'} />}
                <input className="h-7 min-w-0 flex-1 rounded border border-[var(--app-control-border)] bg-[var(--app-surface)] px-2 font-mono text-[10px] text-[var(--app-foreground)] outline-none focus:border-[var(--app-focus-ring)]" onChange={(event) => { const value = event.currentTarget.value; setThemeDrafts((current) => ({ ...current, [token]: value })); updateThemeToken(token, value) }} value={themeDrafts[token] ?? currentValue} />
              </span>
            </label>
          ))}
          {browserState.themeTokens && Object.keys(browserState.themeTokens).length === 0 && <p>{t('当前页面没有可编辑的颜色变量。')}</p>}
          {!browserState.themeTokens && <button className="h-7 rounded border border-[var(--app-control-border)] px-3 hover:bg-[var(--app-hover)]" onClick={() => workbenchRef.current?.readThemeTokens()} type="button">{t('读取主题变量')}</button>}
          {pendingEdits.some((edit) => edit.kind === 'theme') && <div className="mt-3 space-y-2 border-t border-[var(--app-border)] pt-3"><p>{t('{count} pending changes', { count: pendingEdits.length })}</p>{applyError && <p className="text-[var(--app-danger)]">{applyError}</p>}<div className="flex gap-2"><button className="h-7 flex-1 rounded border border-[var(--app-control-border)] hover:bg-[var(--app-hover)]" onClick={resetDesign} type="button">{t('Reset')}</button><button className="h-7 flex-1 rounded bg-[var(--app-submit-background)] px-2 font-medium text-[var(--app-submit-foreground)] disabled:opacity-45" disabled={showingBefore} onClick={() => void applyDesignChanges()} type="button">{t('Apply changes')}</button></div></div>}
        </div>}
        {panelTab === 'layers' && <div className="space-y-1">
          <div className="mb-2 flex items-center justify-between"><p className="font-medium text-[var(--app-foreground)]">{t('图层')}</p><button aria-label={t('刷新图层')} className="flex size-7 items-center justify-center rounded hover:bg-[var(--app-hover)]" onClick={() => workbenchRef.current?.readLayers()} type="button"><RotateCw className="size-3.5" /></button></div>
          {(browserState.previewLayers ?? []).map((layer) => <button className="flex h-7 w-full items-center gap-1.5 truncate rounded pr-2 text-left hover:bg-[var(--app-hover)] hover:text-[var(--app-foreground)]" key={layer.element.ref} onClick={() => { setPanelTab('edit'); workbenchRef.current?.activateElement(layer.element.ref) }} style={{ paddingLeft: `${Math.min(10, layer.depth) * 10 + 8}px` }} title={layer.element.selector} type="button"><Layers3 className="size-3 shrink-0" /><span className="truncate">{layer.element.componentName || layer.element.text || layer.element.tagName}</span></button>)}
          {browserState.previewLayers?.length === 0 && <p>{t('当前页面没有可显示的图层。')}</p>}
          {!browserState.previewLayers && <button className="h-7 rounded border border-[var(--app-control-border)] px-3 hover:bg-[var(--app-hover)]" onClick={() => workbenchRef.current?.readLayers()} type="button">{t('读取图层')}</button>}
        </div>}
        {panelTab === 'annotations' && <div className="space-y-3">
          {browserState.canInspect && <button className={`flex h-7 w-full items-center justify-center gap-1.5 rounded border border-[var(--app-control-border)] px-2 hover:bg-[var(--app-hover)] ${browserState.annotateMode ? 'bg-[var(--app-active)] text-[var(--app-foreground)]' : ''}`} onClick={() => workbenchRef.current?.setInspectionMode(browserState.annotateMode ? 'none' : 'annotate')} type="button"><MessageSquarePlus className="size-3.5" />{browserState.annotateMode ? t('停止') : t('Annotate')}</button>}
          {annotationDraft && <div className="space-y-2 rounded-md border border-[var(--app-control-border)] p-2">
            <div className="flex items-center justify-between gap-2"><div className="min-w-0"><p className="font-medium text-[var(--app-foreground)]">{annotationDraft.label || t('批注区域')}</p><p className="truncate font-mono text-[10px]">{annotationDraft.pagePath}</p></div><button aria-label={t('取消批注')} className="flex size-6 shrink-0 items-center justify-center rounded hover:bg-[var(--app-hover)]" onClick={() => setAnnotationDraft(null)} type="button"><X className="size-3.5" /></button></div>
            {annotationDraft.screenshotDataUrl ? <img alt={t('批注截图')} className="max-h-36 w-full rounded border border-[var(--app-border)] object-cover object-top" src={annotationDraft.screenshotDataUrl} /> : <div className="flex h-20 items-center justify-center gap-2 rounded bg-[var(--app-surface)]">{annotationDraft.capturing && <LoaderCircle className="size-3.5 animate-spin" />}{annotationDraft.capturing ? t('正在捕获批注截图…') : t('截图捕获失败，请重新选择区域')}</div>}
            <textarea className="min-h-20 w-full resize-y rounded border border-[var(--app-control-border)] bg-[var(--app-surface)] p-2 text-xs text-[var(--app-foreground)] outline-none focus:border-[var(--app-focus-ring)]" maxLength={2000} onChange={(event) => setAnnotationComment(event.currentTarget.value)} placeholder={t('描述需要调整的内容')} value={annotationComment} />
            <button className="flex h-7 w-full items-center justify-center gap-1.5 rounded bg-[var(--app-submit-background)] px-2 font-medium text-[var(--app-submit-foreground)] disabled:opacity-45" disabled={annotationBusy || annotationDraft.capturing || !annotationDraft.screenshotDataUrl || !annotationComment.trim()} onClick={() => void saveAnnotation()} type="button">{annotationBusy ? <LoaderCircle className="size-3 animate-spin" /> : <MessageSquarePlus className="size-3" />}{t('保存批注')}</button>
          </div>}
          {annotationError && <p className="text-[var(--app-danger)]">{annotationError}</p>}
          {!annotationDraft && !annotations.length && <div className="space-y-2 py-3 text-center"><MessageSquarePlus className="mx-auto size-5" /><p>{t('点击工具栏批注按钮，再点击预览元素或拖动选择区域。')}</p></div>}
          {annotations.map((annotation, index) => <div className="rounded-md border border-[var(--app-control-border)] p-2" key={annotation.id}>
            <label className="flex cursor-pointer gap-2"><input checked={annotationSelection.includes(annotation.id)} disabled={!annotationSelection.includes(annotation.id) && annotationSelection.length >= 4} onChange={(event) => toggleAnnotationForChat(annotation.id, event.currentTarget.checked)} type="checkbox" /><span className="min-w-0 flex-1"><span className="block truncate font-medium text-[var(--app-foreground)]">{index + 1}. {annotation.element_label || t('批注区域')}</span><span className="block truncate font-mono text-[10px]">{annotation.page_path}</span><span className="mt-1 line-clamp-3 block text-[11px]">{annotation.comment}</span></span></label>
            <button className="mt-2 flex min-h-7 items-center gap-2 rounded px-1 text-[11px] text-[var(--app-muted)] hover:bg-[var(--app-hover)] hover:text-[var(--app-foreground)]" disabled={screenshotLoadingId === annotation.id} onClick={async () => {
              if (annotation.screenshot_data_url) { setExpandedAnnotationId((current) => current === annotation.id ? null : annotation.id); return }
              setAnnotationError(null)
              try { await loadAnnotationScreenshot(annotation); setExpandedAnnotationId(annotation.id) }
              catch (error) { setAnnotationError(error instanceof Error ? error.message : t('无法读取批注截图')) }
            }} type="button">{screenshotLoadingId === annotation.id ? <LoaderCircle className="size-3 animate-spin" /> : annotation.screenshot_data_url ? <Eye className="size-3" /> : <AppWindow className="size-3" />}{expandedAnnotationId === annotation.id ? t('收起截图') : screenshotLoadingId === annotation.id ? t('正在读取截图…') : t('查看截图')}</button>
            {expandedAnnotationId === annotation.id && annotation.screenshot_data_url && <img alt={t('批注截图')} className="mt-1 max-h-40 w-full rounded border border-[var(--app-border)] object-contain object-top" src={annotation.screenshot_data_url} />}
          </div>)}
          {annotations.length > 0 && <div className="space-y-2 border-t border-[var(--app-border)] pt-3"><p>{t('最多选择 4 条批注，并将截图作为视觉上下文发送。')}</p><button className="flex h-8 w-full items-center justify-center gap-1.5 rounded bg-[var(--app-submit-background)] px-2 font-medium text-[var(--app-submit-foreground)] disabled:opacity-45" disabled={sendingAnnotations || !annotationSelection.length} onClick={() => void sendAnnotationBatch()} type="button">{sendingAnnotations ? <LoaderCircle className="size-3.5 animate-spin" /> : <MessageSquarePlus className="size-3.5" />}{t('发送所选批注到项目聊天')}</button></div>}
        </div>}
      </div>
      <div className="space-y-2 border-t border-[var(--app-border)] px-3 py-2 text-[10px] text-[var(--app-subtle-foreground)]">
        <div className="text-[var(--app-muted)]">{t('项目')}</div>
        <DropdownMenu>
          <DropdownMenuTrigger render={<button aria-label={t('项目')} className="flex h-7 w-full items-center justify-between gap-2 rounded-md border border-[var(--app-control-border)] bg-[var(--app-surface)] px-2 text-left text-xs text-[var(--app-foreground)] hover:bg-[var(--app-hover)]" type="button" />}>
            <span className="truncate">{previewProjects.find((project) => project.id === selectedPreviewProjectId)?.name ?? t('项目')}</span>
            <span aria-hidden className="text-[var(--app-muted)]">⌄</span>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="max-h-64 w-[250px] overflow-y-auto rounded-xl border border-[var(--app-border)] bg-[var(--app-elevated)] p-1.5 text-[var(--app-foreground)] shadow-[0_12px_36px_var(--app-shadow)] ring-0">
            {previewProjects.map((project) => <DropdownMenuItem className="h-8 cursor-pointer gap-2 rounded-md px-2.5 text-xs focus:bg-[var(--app-hover)]" key={project.id} onClick={() => onSelectPreviewProject(project.id)}>
              <span className="min-w-0 flex-1 truncate">{project.name}</span>
              {project.id === selectedPreviewProjectId && <span className="text-[10px] text-[var(--app-brand)]">{t('当前')}</span>}
            </DropdownMenuItem>)}
          </DropdownMenuContent>
        </DropdownMenu>
        <div className="truncate" title={browserState.previewTargets.find((target) => target.id === targetId)?.label ?? t('预览目标')}>
          {browserState.previewTargets.find((target) => target.id === targetId)?.label ?? t('预览目标')}
        </div>
      </div>
    </aside>
  )
})
