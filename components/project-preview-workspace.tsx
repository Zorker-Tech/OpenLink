'use client'

import { AppSidebarAccountFooter } from '@/components/app-sidebar-controls'
import { OrganizationDialog } from '@/components/organization-dialog'
import { BrowserWorkbench, type BrowserWorkbenchHandle, type BrowserWorkbenchUiState } from '@/components/browser/browser-workbench'
import { WorkspaceSwitcher, type ActiveWorkspaceSummary, type PersonalWorkspaceSummary } from '@/components/workspace-switcher'
import { WorkspaceNavigationRail } from '@/components/workspace-navigation'
import { OpenLinkThemeProvider } from '@/components/ui/theme-scope'
import { createChatSessionAction } from '@/app/chat/actions'
import type { ThemeMode } from '@/components/account-drawer'
import type { BrowserPreviewAnnotationTarget, PreviewInspectionMode } from '@/components/browser/browser-workbench'
import { useT } from '@/lib/i18n/client'
import type { OrganizationSummary } from '@/lib/organizations'
import { isPreviewTargetId } from '@/lib/browser-preview-target-id'
import { AppWindow, ArrowLeft, ArrowRight, ExternalLink, Eye, Layers3, LoaderCircle, MessageSquarePlus, Monitor, Palette, RotateCw, Smartphone, Undo2, Redo2, WandSparkles, X } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useRef, useState } from 'react'

interface ProjectPreviewWorkspaceProps {
  activeWorkspace: ActiveWorkspaceSummary
  personalWorkspace: PersonalWorkspaceSummary
  organizations: OrganizationSummary[]
  projects: PreviewProjectSummary[]
  selectedProjectId?: string
  nickname: string
  email: string
  avatarUrl: string | null
  initialPreviewTargetId?: string
}

interface PreviewProjectSummary {
  id: string
  name: string
  source_url: string | null
  description: string
}

type PreviewPanelTab = 'edit' | 'theme' | 'layers' | 'annotations'
type PreviewEdit = {
  key: string
  kind: 'style' | 'theme'
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
  created_at: string
}

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

const STYLE_PROPERTIES = [
  'color', 'background-color', 'font-size', 'font-weight', 'line-height', 'width', 'height',
  'margin', 'padding', 'gap', 'border-radius', 'border-color', 'border-width', 'opacity',
  'display', 'justify-content', 'align-items', 'flex-direction', 'box-shadow', 'text-align',
]

function safePreviewPagePath(address: string): string {
  try {
    const url = new URL(address)
    return url.pathname.replace(/^\/v1\/browser\/(?:gateway\/)?sessions\/[^/]+\/preview(?=\/|$)/, '') || '/'
  } catch {
    return address.startsWith('/') ? address : '/'
  }
}

const EMPTY_BROWSER_STATE: BrowserWorkbenchUiState = {
  address: '',
  canGoBack: false,
  canGoForward: false,
  canInspect: false,
  inspectMode: false,
  annotateMode: false,
  status: 'connecting',
  surface: 'native-preview',
  previewTargets: [],
  previewTargetsLoading: true,
}

export function ProjectPreviewWorkspace({
  activeWorkspace,
  personalWorkspace,
  organizations,
  projects,
  selectedProjectId: initialProjectId,
  nickname,
  email,
  avatarUrl,
  initialPreviewTargetId,
}: ProjectPreviewWorkspaceProps) {
  const t = useT()
  const router = useRouter()
  const workbenchRef = useRef<BrowserWorkbenchHandle | null>(null)
  const targetSyncRef = useRef<string | null>(null)
  const [projectId, setProjectId] = useState(initialProjectId ?? '')
  const [activeInitialTargetId, setActiveInitialTargetId] = useState(initialPreviewTargetId)
  const [browserState, setBrowserState] = useState(EMPTY_BROWSER_STATE)
  const [viewport, setViewport] = useState<'browser' | 'mobile'>('browser')
  const [themeMode, setThemeMode] = useState<ThemeMode>('dark')
  const [systemLight, setSystemLight] = useState(false)
  const [organizationDialogOpen, setOrganizationDialogOpen] = useState(false)
  const [addressDraft, setAddressDraft] = useState('')
  const [openingChat, setOpeningChat] = useState(false)
  const [panelTab, setPanelTab] = useState<PreviewPanelTab>('edit')
  const [panelOpen, setPanelOpen] = useState(false)
  const [pendingEdits, setPendingEdits] = useState<PreviewEdit[]>([])
  const [undoStack, setUndoStack] = useState<PreviewEdit[][]>([])
  const [redoStack, setRedoStack] = useState<PreviewEdit[][]>([])
  const [showingBefore, setShowingBefore] = useState(false)
  const [styleDrafts, setStyleDrafts] = useState<Record<string, string>>({})
  const [themeDrafts, setThemeDrafts] = useState<Record<string, string>>({})
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
  const previewViewportRef = useRef<HTMLDivElement | null>(null)
  const [previewViewport, setPreviewViewport] = useState({ width: 1280, height: 800 })
  const selectedProject = projects.find((project) => project.id === projectId)
  const activeTheme = themeMode === 'light' || (themeMode === 'system' && systemLight) ? 'light' : 'dark'

  useEffect(() => {
    const savedTheme = window.localStorage.getItem('openlink-theme') as ThemeMode | null
    if (savedTheme === 'system' || savedTheme === 'light' || savedTheme === 'dark') setThemeMode(savedTheme)
    const media = window.matchMedia('(prefers-color-scheme: light)')
    const update = () => setSystemLight(media.matches)
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])

  useEffect(() => {
    const root = document.documentElement
    if (activeTheme === 'dark') root.classList.add('dark')
    else root.classList.remove('dark')
  }, [activeTheme])

  useEffect(() => {
    setProjectId(initialProjectId ?? '')
  }, [initialProjectId])

  useEffect(() => {
    setActiveInitialTargetId(initialPreviewTargetId)
  }, [initialPreviewTargetId])

  useEffect(() => {
    if (!projectId || browserState.previewTargetsLoading) return
    const targetId = browserState.activePreviewTargetId && isPreviewTargetId(browserState.activePreviewTargetId)
      ? browserState.activePreviewTargetId
      : null
    if (targetSyncRef.current === targetId) return
    targetSyncRef.current = targetId
    const query = new URLSearchParams({ project: projectId })
    if (targetId) query.set('target', targetId)
    router.replace(`/app/${activeWorkspace.slug}/preview?${query.toString()}`, { scroll: false })
  }, [activeWorkspace.slug, browserState.activePreviewTargetId, browserState.previewTargetsLoading, projectId, router])

  useEffect(() => {
    setAddressDraft(browserState.address)
  }, [browserState.address])

  useEffect(() => {
    if (!browserState.selectedStyles) return
    setStyleDrafts(browserState.selectedStyles)
  }, [browserState.selectedElement?.ref, browserState.selectedStyles])

  useEffect(() => {
    if (browserState.themeTokens) setThemeDrafts(browserState.themeTokens)
  }, [browserState.themeTokens])

  useEffect(() => {
    if (panelTab === 'theme') workbenchRef.current?.readThemeTokens()
    if (panelTab === 'layers') workbenchRef.current?.readLayers()
  }, [panelTab])

  useEffect(() => {
    setPendingEdits([])
    setUndoStack([])
    setRedoStack([])
    setShowingBefore(false)
    setStyleDrafts({})
    setThemeDrafts({})
    setAnnotationDraft(null)
    setAnnotations([])
    setAnnotationSelection([])
    setExpandedAnnotationId(null)
    setScreenshotLoadingId(null)
  }, [projectId])

  useEffect(() => {
    const element = previewViewportRef.current
    if (!element) return
    const observer = new ResizeObserver(() => {
      const rect = element.getBoundingClientRect()
      setPreviewViewport({
        width: Math.max(240, Math.min(2560, Math.round(rect.width))),
        height: Math.max(240, Math.min(4320, Math.round(rect.height))),
      })
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [projectId])

  useEffect(() => {
    const targetId = browserState.activePreviewTargetId
    if (!projectId || !targetId || !isPreviewTargetId(targetId)) {
      setAnnotations([])
      setAnnotationSelection([])
      setAnnotationDraft(null)
      setExpandedAnnotationId(null)
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
  }, [browserState.activePreviewTargetId, projectId, t])

  const selectProject = useCallback((nextProjectId: string) => {
    if (!projects.some((project) => project.id === nextProjectId)) return
    targetSyncRef.current = null
    setActiveInitialTargetId(undefined)
    setProjectId(nextProjectId)
    setBrowserState(EMPTY_BROWSER_STATE)
    router.replace(`/app/${activeWorkspace.slug}/preview?project=${encodeURIComponent(nextProjectId)}`, { scroll: false })
  }, [activeWorkspace.slug, projects, router])

  const openProjectChat = useCallback(async () => {
    if (!selectedProject || openingChat) return
    setOpeningChat(true)
    try {
      const result = await createChatSessionAction({ workspaceSlug: activeWorkspace.slug, projectId: selectedProject.id })
      if (result.path) router.push(result.path)
    } finally {
      setOpeningChat(false)
    }
  }, [activeWorkspace.slug, openingChat, router, selectedProject])

  const handleStateChange = useCallback((state: BrowserWorkbenchUiState) => {
    setBrowserState(state)
  }, [])

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
    if (changed) next.push({
      key,
      kind: 'style',
      ref: element.ref,
      property,
      selector: element.selector || element.tagName,
      label: element.componentName || element.text || element.tagName,
      before,
      after: value,
    })
    pushEditSnapshot(next)
    if (changed) workbenchRef.current?.setElementStyle(element.ref, property, value)
    else workbenchRef.current?.resetElementStyle(element.ref, property)
  }, [browserState.selectedElement, browserState.selectedStyles, pendingEdits, pushEditSnapshot, showingBefore])

  const updateThemeToken = useCallback((token: string, value: string) => {
    if (showingBefore) return
    const key = `theme:${token}`
    const existing = pendingEdits.find((edit) => edit.key === key)
    const before = existing?.before ?? browserState.themeTokens?.[token] ?? ''
    const next = pendingEdits.filter((edit) => edit.key !== key)
    const changed = value.trim() !== before.trim()
    if (changed) next.push({
      key,
      kind: 'theme',
      ref: 'root',
      property: token,
      selector: ':root',
      label: token,
      before,
      after: value,
    })
    pushEditSnapshot(next)
    if (changed) workbenchRef.current?.setThemeToken(token, value)
    else workbenchRef.current?.resetThemeToken(token)
  }, [browserState.themeTokens, pendingEdits, pushEditSnapshot, showingBefore])

  const applyEditSnapshot = useCallback((from: PreviewEdit[], to: PreviewEdit[]) => {
    const fromByKey = new Map(from.map((edit) => [edit.key, edit]))
    const toByKey = new Map(to.map((edit) => [edit.key, edit]))
    for (const key of new Set([...fromByKey.keys(), ...toByKey.keys()])) {
      const previous = fromByKey.get(key)
      const next = toByKey.get(key)
      if (next) {
        if (next.kind === 'style') workbenchRef.current?.setElementStyle(next.ref, next.property, next.after)
        else workbenchRef.current?.setThemeToken(next.property, next.after)
      } else if (previous?.kind === 'style') workbenchRef.current?.resetElementStyle(previous.ref, previous.property)
      else if (previous) workbenchRef.current?.resetThemeToken(previous.property)
    }
    setPendingEdits(to)
    setShowingBefore(false)
  }, [])

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
      else workbenchRef.current?.setThemeToken(edit.property, showBefore ? edit.before : edit.after)
    }
    setShowingBefore(showBefore)
  }, [pendingEdits, showingBefore])

  const resetDesign = useCallback(() => {
    for (const edit of pendingEdits) {
      if (edit.kind === 'style') workbenchRef.current?.resetElementStyle(edit.ref, edit.property)
      else workbenchRef.current?.resetThemeToken(edit.property)
    }
    setPendingEdits([])
    setUndoStack([])
    setRedoStack([])
    setShowingBefore(false)
  }, [pendingEdits])

  const applyDesignChanges = useCallback(async () => {
    if (!selectedProject || !pendingEdits.length || openingChat) return
    setOpeningChat(true)
    setApplyError(null)
    const changeList = pendingEdits.map((edit) => `- ${edit.selector} (${edit.label}): ${edit.property} ${edit.before || '(default)'} -> ${edit.after}`).join('\n')
    const prompt = [
      'Apply these visual changes to the editable source code for the current project.',
      `Preview page: ${safePreviewPagePath(browserState.address)}`,
      'Treat the element selectors and styles as visual guidance. Find the responsible source components, make the smallest appropriate code changes, and leave a reviewable diff. Do not commit changes.',
      'Requested changes:',
      changeList,
    ].join('\n')
    try {
      const result = await createChatSessionAction({ workspaceSlug: activeWorkspace.slug, projectId: selectedProject.id, prompt, autoStart: true })
      if (result.path) router.push(result.path)
      else setApplyError(result.fallback ? t('无法打开项目聊天') : t('创建代码任务失败'))
    } catch {
      setApplyError(t('创建代码任务失败'))
    } finally {
      setOpeningChat(false)
    }
  }, [activeWorkspace.slug, browserState.address, openingChat, pendingEdits, router, selectedProject, t])

  const handleAnnotationTarget = useCallback((target: BrowserPreviewAnnotationTarget) => {
    const targetId = browserState.activePreviewTargetId
    if (!selectedProject || !targetId) {
      setAnnotationError(t('请先选择一个预览目标'))
      return
    }
    const id = crypto.randomUUID()
    setAnnotationError(null)
    setAnnotationComment('')
    setPanelTab('annotations')
    setPanelOpen(true)
    const draft: AnnotationDraft = {
      id,
      targetId,
      pagePath: target.pagePath,
      ...(target.element?.selector ? { selector: target.element.selector } : {}),
      ...(target.element ? { label: target.element.componentName || target.element.text || target.element.tagName } : {}),
      bounds: target.bounds,
      viewport: previewViewport,
      capturing: true,
    }
    setAnnotationDraft(draft)
    void fetch('/api/browser/preview-screenshot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: selectedProject.id, previewTargetId: targetId, pagePath: target.pagePath, viewport: { ...previewViewport, deviceScaleFactor: 1 } }),
    }).then(async (response) => {
      const payload = await response.json().catch(() => null) as { image?: { mimeType?: unknown; data?: unknown }; error?: { message?: string } } | null
      if (!response.ok || payload?.image?.mimeType !== 'image/jpeg' || typeof payload.image.data !== 'string') {
        throw new Error(payload?.error?.message || t('无法为批注捕获截图'))
      }
      setAnnotationDraft((current) => current?.id === id ? { ...current, screenshotDataUrl: `data:image/jpeg;base64,${payload.image!.data as string}`, capturing: false } : current)
    }).catch((error) => {
      setAnnotationDraft((current) => current?.id === id ? { ...current, capturing: false } : current)
      setAnnotationError(error instanceof Error ? error.message : t('无法为批注捕获截图'))
    })
  }, [browserState.activePreviewTargetId, previewViewport, selectedProject, t])

  const saveAnnotation = useCallback(async () => {
    if (!selectedProject || !annotationDraft?.screenshotDataUrl || !annotationComment.trim() || annotationBusy) return
    setAnnotationBusy(true)
    setAnnotationError(null)
    try {
      const response = await fetch('/api/browser/preview-annotations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: selectedProject.id,
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
  }, [annotationBusy, annotationComment, annotationDraft, selectedProject, t])

  const toggleAnnotationForChat = useCallback((id: string, checked: boolean) => {
    setAnnotationSelection((current) => {
      if (!checked) return current.filter((value) => value !== id)
      return current.length < 4 && !current.includes(id) ? [...current, id] : current
    })
  }, [])

  const loadAnnotationScreenshot = useCallback(async (annotation: PreviewAnnotation) => {
    if (annotation.screenshot_data_url) return annotation.screenshot_data_url
    if (!projectId) throw new Error(t('无法读取批注截图'))
    setScreenshotLoadingId(annotation.id)
    try {
      const response = await fetch(`/api/browser/preview-annotations/${encodeURIComponent(annotation.id)}/screenshot?projectId=${encodeURIComponent(projectId)}`, { cache: 'no-store' })
      const payload = await response.json().catch(() => null) as { screenshotDataUrl?: unknown; error?: { message?: string } } | null
      if (!response.ok || typeof payload?.screenshotDataUrl !== 'string'
        || !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(payload.screenshotDataUrl)
        || payload.screenshotDataUrl.length > 2_800_050) {
        throw new Error(payload?.error?.message || t('无法读取批注截图'))
      }
      const screenshotDataUrl = payload.screenshotDataUrl
      setAnnotations((current) => current.map((item) => item.id === annotation.id ? { ...item, screenshot_data_url: screenshotDataUrl } : item))
      return screenshotDataUrl
    } finally {
      setScreenshotLoadingId((current) => current === annotation.id ? null : current)
    }
  }, [projectId, t])

  const toggleAnnotationScreenshot = useCallback(async (annotation: PreviewAnnotation) => {
    if (annotation.screenshot_data_url) {
      setExpandedAnnotationId((current) => current === annotation.id ? null : annotation.id)
      return
    }
    setAnnotationError(null)
    try {
      await loadAnnotationScreenshot(annotation)
      setExpandedAnnotationId(annotation.id)
    } catch (error) {
      setAnnotationError(error instanceof Error ? error.message : t('无法读取批注截图'))
    }
  }, [loadAnnotationScreenshot, t])

  const sendAnnotationBatch = useCallback(async () => {
    if (!selectedProject || !annotationSelection.length || sendingAnnotations) return
    setSendingAnnotations(true)
    setAnnotationError(null)
    try {
      const selected = annotations.filter((annotation) => annotationSelection.includes(annotation.id))
      const selectedWithScreenshots = await Promise.all(selected.map(async (annotation) => ({
        annotation,
        screenshotDataUrl: await loadAnnotationScreenshot(annotation),
      })))
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
      const created = await createChatSessionAction({ workspaceSlug: activeWorkspace.slug, projectId: selectedProject.id })
      if (!created.id || !created.path) throw new Error(t('无法创建项目聊天'))
      const attachments = selectedWithScreenshots.map(({ annotation, screenshotDataUrl }, index) => ({
        type: 'image',
        mediaType: 'image/jpeg',
        url: screenshotDataUrl,
        filename: `preview-annotation-${index + 1}.jpg`,
      }))
      const response = await fetch(`/api/chat/${encodeURIComponent(created.id)}/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: prompt, attachments }),
      })
      const payload = await response.json().catch(() => null) as { error?: string } | null
      if (!response.ok) throw new Error(payload?.error || t('发送批注失败'))
      router.push(created.path)
    } catch (error) {
      setAnnotationError(error instanceof Error ? error.message : t('发送批注失败'))
    } finally {
      setSendingAnnotations(false)
    }
  }, [activeWorkspace.slug, annotationSelection, annotations, loadAnnotationScreenshot, router, selectedProject, sendingAnnotations, t])

  const targetLabel = browserState.previewTargets.find((target) => target.id === browserState.activePreviewTargetId)?.label
  const currentPagePath = safePreviewPagePath(browserState.address)
  const visibleAnnotations = annotations.filter((annotation) => annotation.page_path === currentPagePath)

  return (
    <OpenLinkThemeProvider theme={activeTheme}>
      <div className="openlink-app-shell flex h-dvh min-h-[500px] overflow-hidden" data-theme={activeTheme}>
        <WorkspaceNavigationRail
          activePage={t('预览')}
          footer={<AppSidebarAccountFooter compact activeWorkspace={activeWorkspace} avatarUrl={avatarUrl} email={email} nickname={nickname} onOpenOrganization={() => setOrganizationDialogOpen(true)} onThemeChange={(mode) => { setThemeMode(mode); window.localStorage.setItem('openlink-theme', mode) }} organizations={organizations} themeMode={themeMode} />}
          onCloseMobile={() => {}}
          onHistory={() => router.push(`/app/${activeWorkspace.slug}`)}
          sidebarWidth={288}
          workspaceSlug={activeWorkspace.slug}
        />

        <main className="flex min-w-0 flex-1 flex-col bg-[var(--app-background)]">
          <header className="flex h-12 shrink-0 items-center gap-3 border-b border-[var(--app-border)] px-3">
            <div className="w-[190px] min-w-0"><WorkspaceSwitcher activeWorkspace={activeWorkspace} organizations={organizations} personalWorkspace={personalWorkspace} onAddOrganization={() => setOrganizationDialogOpen(true)} /></div>
            <span className="hidden h-5 w-px bg-[var(--app-border)] sm:block" />
            <label className="flex min-w-0 flex-1 items-center gap-2">
              <AppWindow className="size-4 shrink-0 text-[var(--app-muted)]" />
              <span className="sr-only">{t('选择项目')}</span>
              <select aria-label={t('选择项目')} className="h-8 min-w-0 flex-1 rounded-md border border-[var(--app-control-border)] bg-[var(--app-surface)] px-2 text-sm text-[var(--app-foreground)] outline-none focus:border-[var(--app-focus-ring)]" onChange={(event) => selectProject(event.currentTarget.value)} value={projectId}>
                {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
              </select>
            </label>
            {selectedProject && <span className="hidden max-w-[220px] truncate text-xs text-[var(--app-muted)] lg:block" title={selectedProject.source_url ?? selectedProject.description}>{selectedProject.source_url || selectedProject.description || t('项目工作区')}</span>}
            <button className="flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-[var(--app-control-border)] px-2.5 text-xs font-medium text-[var(--app-foreground)] hover:bg-[var(--app-hover)] disabled:opacity-50" disabled={!selectedProject || openingChat} onClick={() => void openProjectChat()} type="button">
              {openingChat ? <LoaderCircle className="size-3.5 animate-spin" /> : <MessageSquarePlus className="size-3.5" />}
              <span className="hidden sm:inline">{t('在聊天中继续')}</span>
            </button>
          </header>

          {selectedProject ? (
            <div className="flex min-h-0 flex-1 flex-col">
              <div aria-label={t('预览工具栏')} className="flex h-11 shrink-0 items-center gap-1.5 border-b border-[var(--app-border)] px-2">
                <button aria-label={t('后退')} className="flex size-7 items-center justify-center rounded-md text-[var(--app-muted)] hover:bg-[var(--app-hover)] disabled:opacity-35" disabled={!browserState.canGoBack} onClick={() => workbenchRef.current?.back()} type="button"><ArrowLeft className="size-4" /></button>
                <button aria-label={t('前进')} className="flex size-7 items-center justify-center rounded-md text-[var(--app-muted)] hover:bg-[var(--app-hover)] disabled:opacity-35" disabled={!browserState.canGoForward} onClick={() => workbenchRef.current?.forward()} type="button"><ArrowRight className="size-4" /></button>
                <button aria-label={t('桌面视口')} aria-pressed={viewport === 'browser'} className={`flex size-7 items-center justify-center rounded-md ${viewport === 'browser' ? 'bg-[var(--app-active)] text-[var(--app-foreground)]' : 'text-[var(--app-muted)] hover:bg-[var(--app-hover)]'}`} onClick={() => setViewport('browser')} type="button"><Monitor className="size-4" /></button>
                <button aria-label={t('移动视口')} aria-pressed={viewport === 'mobile'} className={`flex size-7 items-center justify-center rounded-md ${viewport === 'mobile' ? 'bg-[var(--app-active)] text-[var(--app-foreground)]' : 'text-[var(--app-muted)] hover:bg-[var(--app-hover)]'}`} onClick={() => setViewport('mobile')} type="button"><Smartphone className="size-4" /></button>
                <form className="mx-auto flex h-7 min-w-[140px] max-w-[520px] flex-1 items-center overflow-hidden rounded-md border border-[var(--app-control-border)] px-1" onSubmit={(event) => { event.preventDefault(); workbenchRef.current?.navigate(addressDraft) }}>
                  <input aria-label={t('预览路径')} className="h-6 min-w-0 flex-1 bg-transparent px-1 text-xs text-[var(--app-foreground)] outline-none placeholder:text-[var(--app-subtle-foreground)]" onBlur={() => setAddressDraft(browserState.address)} onChange={(event) => setAddressDraft(event.currentTarget.value)} onFocus={(event) => { if (event.currentTarget.value.startsWith('http')) event.currentTarget.select() }} placeholder="/" value={addressDraft} />
                  {targetLabel && <span className="hidden max-w-[110px] truncate border-l border-[var(--app-border)] pl-2 text-[10px] text-[var(--app-muted)] md:block" title={targetLabel}>{targetLabel}</span>}
                </form>
                <select aria-label={t('预览目标')} className="h-7 max-w-[150px] rounded-md border border-[var(--app-control-border)] bg-[var(--app-surface)] px-1.5 text-[11px] text-[var(--app-muted)] outline-none focus:border-[var(--app-focus-ring)] disabled:opacity-50" disabled={browserState.previewTargetsLoading || !browserState.previewTargets.length} onChange={(event) => workbenchRef.current?.selectPreviewTarget(event.currentTarget.value)} value={browserState.activePreviewTargetId ?? ''}>
                  {!browserState.activePreviewTargetId && <option value="">{browserState.previewTargetsLoading ? t('正在发现…') : t('预览目标')}</option>}
                  {browserState.previewTargets.map((target) => <option key={target.id} value={target.id}>{target.label}</option>)}
                </select>
                <button aria-label={t('Edit')} aria-pressed={browserState.inspectMode} className={`flex size-7 items-center justify-center rounded-md ${browserState.inspectMode ? 'bg-[var(--app-active)] text-[var(--app-foreground)]' : 'text-[var(--app-muted)] hover:bg-[var(--app-hover)]'} disabled:opacity-35`} disabled={!browserState.canInspect} onClick={() => { setPanelTab('edit'); setPanelOpen(true); workbenchRef.current?.setInspectionMode(browserState.inspectMode ? 'none' : 'edit') }} type="button"><WandSparkles className="size-4" /></button>
                <button aria-label={t('Annotate')} aria-pressed={browserState.annotateMode} className={`flex size-7 items-center justify-center rounded-md ${browserState.annotateMode ? 'bg-[var(--app-active)] text-[var(--app-foreground)]' : 'text-[var(--app-muted)] hover:bg-[var(--app-hover)]'} disabled:opacity-35`} disabled={!browserState.canInspect} onClick={() => { const nextMode: PreviewInspectionMode = browserState.annotateMode ? 'none' : 'annotate'; workbenchRef.current?.setInspectionMode(nextMode); if (nextMode === 'annotate') { setPanelTab('annotations'); setPanelOpen(true) } }} type="button"><MessageSquarePlus className="size-4" /></button>
                <button aria-label={t('预览工具')} aria-pressed={panelOpen} className={`flex size-7 items-center justify-center rounded-md md:hidden ${panelOpen ? 'bg-[var(--app-active)] text-[var(--app-foreground)]' : 'text-[var(--app-muted)] hover:bg-[var(--app-hover)]'}`} onClick={() => setPanelOpen((open) => !open)} type="button"><Layers3 className="size-4" /></button>
                <button aria-label={t('在新窗口打开')} className="flex size-7 items-center justify-center rounded-md text-[var(--app-muted)] hover:bg-[var(--app-hover)] disabled:opacity-35" disabled={!browserState.externalUrl} onClick={() => workbenchRef.current?.openExternal()} type="button"><ExternalLink className="size-4" /></button>
                <button aria-label={t('刷新')} className="flex size-7 items-center justify-center rounded-md text-[var(--app-muted)] hover:bg-[var(--app-hover)] disabled:opacity-35" disabled={browserState.status === 'connecting' || browserState.status === 'reconnecting'} onClick={() => workbenchRef.current?.reload()} type="button"><RotateCw className="size-4" /></button>
              </div>
              <div className="relative flex min-h-0 flex-1 overflow-hidden">
                <section aria-label={t('预览画布')} className={`relative flex min-w-0 flex-1 items-center justify-center overflow-hidden bg-[var(--app-editor-background)] ${viewport === 'mobile' ? 'p-3' : ''}`}>
                  <div className={viewport === 'mobile' ? 'relative h-full max-h-[835px] w-full max-w-[391px] overflow-hidden rounded-[24px] border border-[var(--app-border)] shadow-xl' : 'relative size-full'} ref={previewViewportRef}>
                    <BrowserWorkbench
                      allowRealtimeFallback={false}
                      initialPreviewTargetId={activeInitialTargetId}
                      initialSurface="native-preview"
                      key={selectedProject.id}
                      onAnnotationTarget={handleAnnotationTarget}
                      onStateChange={handleStateChange}
                      projectId={selectedProject.id}
                      ref={workbenchRef}
                      viewportMode={viewport}
                    />
                    {visibleAnnotations.map((annotation, index) => <button aria-label={t('第 {number} 条批注', { number: index + 1 })} className="absolute z-30 flex size-5 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-2 border-white bg-[var(--app-focus-ring)] text-[10px] font-semibold text-white shadow" key={annotation.id} onClick={() => { setPanelTab('annotations'); setPanelOpen(true) }} style={{ left: `${annotation.bounds.x / annotation.viewport.width * 100}%`, top: `${annotation.bounds.y / annotation.viewport.height * 100}%` }} type="button">{index + 1}</button>)}
                  </div>
                </section>
                <aside aria-label={t('预览工具')} className={panelOpen ? 'absolute inset-y-0 right-0 z-30 flex w-[min(320px,90vw)] shrink-0 flex-col border-l border-[var(--app-border)] bg-[var(--app-background)] shadow-xl md:static md:w-[300px] md:shadow-none' : 'hidden md:flex md:w-[300px] md:shrink-0 md:flex-col md:border-l md:border-[var(--app-border)] md:bg-[var(--app-background)]'}>
                  <div className="relative grid h-14 shrink-0 grid-cols-4 border-b border-[var(--app-border)]">
                    {([['edit', 'Edit', WandSparkles], ['theme', 'Theme', Palette], ['layers', 'Layers', Layers3], ['annotations', '批注', MessageSquarePlus]] as const).map(([tab, label, Icon]) => (
                      <button aria-selected={panelTab === tab} className={`flex flex-col items-center justify-center gap-1 border-b-2 text-[10px] ${panelTab === tab ? 'border-[var(--app-focus-ring)] text-[var(--app-foreground)]' : 'border-transparent text-[var(--app-muted)] hover:text-[var(--app-foreground)]'}`} key={tab} onClick={() => { setPanelTab(tab); setPanelOpen(true); if (tab === 'edit') workbenchRef.current?.setInspectionMode('edit'); else workbenchRef.current?.setInspectionMode('none') }} role="tab" type="button"><Icon className="size-4" />{t(label)}</button>
                    ))}
                    <button aria-label={t('关闭预览工具')} className="absolute right-1 top-1 flex size-6 items-center justify-center rounded text-[var(--app-muted)] hover:bg-[var(--app-hover)] md:hidden" onClick={() => setPanelOpen(false)} type="button"><X className="size-3.5" /></button>
                  </div>
                  <div className="min-h-0 flex-1 overflow-y-auto p-3 text-xs leading-5 text-[var(--app-muted)]">
                    {!browserState.previewTargets.length && !browserState.previewTargetsLoading && <p className="mb-3 rounded-md border border-[var(--app-control-border)] p-2">{t('未发现运行中的开发服务器。启动项目 Web 服务后刷新目标。')}</p>}
                    {browserState.previewTargetsLoading && <p className="mb-3 flex items-center gap-2"><LoaderCircle className="size-3.5 animate-spin" />{t('正在发现项目开发服务器…')}</p>}
                    {browserState.previewTargetsError && <p className="mb-3 text-[var(--app-danger)]">{browserState.previewTargetsError}</p>}
                    {panelTab === 'edit' && (
                      <div className="space-y-3">
                        {browserState.selectedElement ? (
                          <>
                            <div className="rounded-md border border-[var(--app-control-border)] p-2">
                              <p className="truncate font-medium text-[var(--app-foreground)]">{browserState.selectedElement.componentName || browserState.selectedElement.tagName}</p>
                              <p className="mt-0.5 truncate font-mono text-[10px]" title={browserState.selectedElement.selector}>{browserState.selectedElement.selector}</p>
                            </div>
                            <div className="flex items-center gap-1">
                              <button aria-label={t('Undo')} className="flex size-7 items-center justify-center rounded border border-[var(--app-control-border)] disabled:opacity-35" disabled={!undoStack.length} onClick={undoEdit} type="button"><Undo2 className="size-3.5" /></button>
                              <button aria-label={t('Redo')} className="flex size-7 items-center justify-center rounded border border-[var(--app-control-border)] disabled:opacity-35" disabled={!redoStack.length} onClick={redoEdit} type="button"><Redo2 className="size-3.5" /></button>
                              <button className="ml-auto flex h-7 items-center gap-1 rounded border border-[var(--app-control-border)] px-2 text-[10px] disabled:opacity-35" disabled={!pendingEdits.length} onClick={toggleBeforeAfter} type="button"><Eye className="size-3" />{showingBefore ? t('Show after') : t('Before / after')}</button>
                            </div>
                            <div className="space-y-2">
                              {STYLE_PROPERTIES.map((property) => (
                                <label className="grid grid-cols-[106px_minmax(0,1fr)] items-center gap-2" key={property}>
                                  <span className="truncate font-mono text-[10px]">{property}</span>
                                  <input className="h-7 min-w-0 rounded border border-[var(--app-control-border)] bg-[var(--app-surface)] px-2 font-mono text-[10px] text-[var(--app-foreground)] outline-none focus:border-[var(--app-focus-ring)] disabled:opacity-50" disabled={showingBefore || !browserState.selectedStyles} onChange={(event) => { const value = event.currentTarget.value; setStyleDrafts((current) => ({ ...current, [property]: value })); updateStyle(property, value) }} value={styleDrafts[property] ?? browserState.selectedStyles?.[property] ?? ''} />
                                </label>
                              ))}
                            </div>
                            {pendingEdits.length > 0 && <div className="space-y-2 border-t border-[var(--app-border)] pt-3">
                              <p>{t('{count} pending changes', { count: pendingEdits.length })}</p>
                              {applyError && <p className="text-[var(--app-danger)]">{applyError}</p>}
                              <div className="flex gap-2">
                                <button className="h-7 flex-1 rounded border border-[var(--app-control-border)] hover:bg-[var(--app-hover)]" onClick={resetDesign} type="button">{t('Reset')}</button>
                                <button className="flex h-7 flex-1 items-center justify-center gap-1 rounded bg-[var(--app-submit-background)] px-2 font-medium text-[var(--app-submit-foreground)] disabled:opacity-45" disabled={openingChat || showingBefore} onClick={() => void applyDesignChanges()} type="button">{openingChat ? <LoaderCircle className="size-3 animate-spin" /> : <WandSparkles className="size-3" />}{t('Apply changes')}</button>
                              </div>
                            </div>}
                          </>
                        ) : (
                          <div className="space-y-3 py-4 text-center">
                            <WandSparkles className="mx-auto size-5" />
                            <p>{t('点击预览中的元素以查看和调整样式。')}</p>
                            <button className="h-7 rounded border border-[var(--app-control-border)] px-3 text-[var(--app-foreground)] hover:bg-[var(--app-hover)]" disabled={!browserState.canInspect} onClick={() => workbenchRef.current?.setInspectionMode('edit')} type="button">{t('选择组件')}</button>
                          </div>
                        )}
                      </div>
                    )}
                    {panelTab === 'theme' && (
                      <div className="space-y-2">
                        <p className="mb-3 text-[11px]">{t('主题颜色来自当前页面可用的 CSS 变量。修改会暂时应用到预览。')}</p>
                        {Object.entries(browserState.themeTokens ?? {}).map(([token, currentValue]) => (
                          <label className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] items-center gap-2" key={token}>
                            <span className="truncate font-mono text-[10px]" title={token}>{token}</span>
                            <input className="h-7 min-w-0 rounded border border-[var(--app-control-border)] bg-[var(--app-surface)] px-2 font-mono text-[10px] text-[var(--app-foreground)] outline-none focus:border-[var(--app-focus-ring)]" onChange={(event) => { const value = event.currentTarget.value; setThemeDrafts((current) => ({ ...current, [token]: value })); updateThemeToken(token, value) }} value={themeDrafts[token] ?? currentValue} />
                          </label>
                        ))}
                        {browserState.themeTokens && Object.keys(browserState.themeTokens).length === 0 && <p>{t('当前页面没有可编辑的颜色变量。')}</p>}
                        {!browserState.themeTokens && <button className="h-7 rounded border border-[var(--app-control-border)] px-3 hover:bg-[var(--app-hover)]" onClick={() => workbenchRef.current?.readThemeTokens()} type="button">{t('读取主题变量')}</button>}
                        {pendingEdits.some((edit) => edit.kind === 'theme') && <div className="mt-3 space-y-2 border-t border-[var(--app-border)] pt-3"><p>{t('{count} pending changes', { count: pendingEdits.length })}</p><div className="flex gap-2"><button className="h-7 flex-1 rounded border border-[var(--app-control-border)] hover:bg-[var(--app-hover)]" onClick={resetDesign} type="button">{t('Reset')}</button><button className="flex h-7 flex-1 items-center justify-center gap-1 rounded bg-[var(--app-submit-background)] px-2 font-medium text-[var(--app-submit-foreground)] disabled:opacity-45" disabled={openingChat || showingBefore} onClick={() => void applyDesignChanges()} type="button">{t('Apply changes')}</button></div></div>}
                      </div>
                    )}
                    {panelTab === 'layers' && (
                      <div className="space-y-1">
                        <div className="mb-2 flex items-center justify-between">
                          <p className="font-medium text-[var(--app-foreground)]">{selectedProject.name}</p>
                          <button aria-label={t('刷新图层')} className="flex size-7 items-center justify-center rounded hover:bg-[var(--app-hover)]" onClick={() => workbenchRef.current?.readLayers()} type="button"><RotateCw className="size-3.5" /></button>
                        </div>
                        {(browserState.previewLayers ?? []).map((layer) => (
                          <button className="flex h-7 w-full items-center gap-1.5 truncate rounded pr-2 text-left hover:bg-[var(--app-hover)] hover:text-[var(--app-foreground)]" key={layer.element.ref} onClick={() => { setPanelTab('edit'); workbenchRef.current?.activateElement(layer.element.ref) }} style={{ paddingLeft: `${Math.min(10, layer.depth) * 10 + 8}px` }} title={layer.element.selector} type="button"><Layers3 className="size-3 shrink-0" /><span className="truncate">{layer.element.componentName || layer.element.text || layer.element.tagName}</span></button>
                        ))}
                        {browserState.previewLayers?.length === 0 && <p>{t('当前页面没有可显示的图层。')}</p>}
                        {!browserState.previewLayers && <button className="h-7 rounded border border-[var(--app-control-border)] px-3 hover:bg-[var(--app-hover)]" onClick={() => workbenchRef.current?.readLayers()} type="button">{t('读取图层')}</button>}
                      </div>
                    )}
                    {panelTab === 'annotations' && (
                      <div className="space-y-3">
                        {annotationDraft && (
                          <div className="space-y-2 rounded-md border border-[var(--app-control-border)] p-2">
                            <div className="flex items-center justify-between gap-2">
                              <div className="min-w-0"><p className="font-medium text-[var(--app-foreground)]">{annotationDraft.label || t('批注区域')}</p><p className="truncate font-mono text-[10px]">{annotationDraft.pagePath}</p></div>
                              <button aria-label={t('取消批注')} className="flex size-6 shrink-0 items-center justify-center rounded hover:bg-[var(--app-hover)]" onClick={() => setAnnotationDraft(null)} type="button"><X className="size-3.5" /></button>
                            </div>
                            {annotationDraft.screenshotDataUrl ? <img alt={t('批注截图')} className="max-h-36 w-full rounded border border-[var(--app-border)] object-cover object-top" src={annotationDraft.screenshotDataUrl} /> : <div className="flex h-20 items-center justify-center gap-2 rounded bg-[var(--app-surface)]">{annotationDraft.capturing && <LoaderCircle className="size-3.5 animate-spin" />}{annotationDraft.capturing ? t('正在捕获批注截图…') : t('截图捕获失败，请重新选择区域')}</div>}
                            <textarea className="min-h-20 w-full resize-y rounded border border-[var(--app-control-border)] bg-[var(--app-surface)] p-2 text-xs text-[var(--app-foreground)] outline-none focus:border-[var(--app-focus-ring)]" maxLength={2000} onChange={(event) => setAnnotationComment(event.currentTarget.value)} placeholder={t('描述需要调整的内容')} value={annotationComment} />
                            <button className="flex h-7 w-full items-center justify-center gap-1.5 rounded bg-[var(--app-submit-background)] px-2 font-medium text-[var(--app-submit-foreground)] disabled:opacity-45" disabled={annotationBusy || annotationDraft.capturing || !annotationDraft.screenshotDataUrl || !annotationComment.trim()} onClick={() => void saveAnnotation()} type="button">{annotationBusy ? <LoaderCircle className="size-3 animate-spin" /> : <MessageSquarePlus className="size-3" />}{t('保存批注')}</button>
                          </div>
                        )}
                        {annotationError && <p className="text-[var(--app-danger)]">{annotationError}</p>}
                        {!annotationDraft && !annotations.length && <div className="space-y-2 py-3 text-center"><MessageSquarePlus className="mx-auto size-5" /><p>{t('点击工具栏批注按钮，再点击预览元素或拖动选择区域。')}</p></div>}
                        {annotations.map((annotation, index) => (
                          <div className="rounded-md border border-[var(--app-control-border)] p-2" key={annotation.id}>
                            <label className="flex cursor-pointer gap-2">
                              <input checked={annotationSelection.includes(annotation.id)} disabled={!annotationSelection.includes(annotation.id) && annotationSelection.length >= 4} onChange={(event) => toggleAnnotationForChat(annotation.id, event.currentTarget.checked)} type="checkbox" />
                              <span className="min-w-0 flex-1"><span className="block truncate font-medium text-[var(--app-foreground)]">{index + 1}. {annotation.element_label || t('批注区域')}</span><span className="block truncate font-mono text-[10px]">{annotation.page_path}</span><span className="mt-1 line-clamp-3 block text-[11px]">{annotation.comment}</span></span>
                            </label>
                            <button className="mt-2 flex min-h-7 items-center gap-2 rounded px-1 text-[11px] text-[var(--app-muted)] hover:bg-[var(--app-hover)] hover:text-[var(--app-foreground)]" disabled={screenshotLoadingId === annotation.id} onClick={() => void toggleAnnotationScreenshot(annotation)} type="button">
                              {screenshotLoadingId === annotation.id ? <LoaderCircle className="size-3 animate-spin" /> : annotation.screenshot_data_url ? <Eye className="size-3" /> : <AppWindow className="size-3" />}
                              {expandedAnnotationId === annotation.id ? t('收起截图') : screenshotLoadingId === annotation.id ? t('正在读取截图…') : t('查看截图')}
                            </button>
                            {expandedAnnotationId === annotation.id && annotation.screenshot_data_url && <img alt={t('批注截图')} className="mt-1 max-h-40 w-full rounded border border-[var(--app-border)] object-contain object-top" src={annotation.screenshot_data_url} />}
                          </div>
                        ))}
                        {annotations.length > 0 && <div className="space-y-2 border-t border-[var(--app-border)] pt-3"><p>{t('最多选择 4 条批注，并将截图作为视觉上下文发送。')}</p><button className="flex h-8 w-full items-center justify-center gap-1.5 rounded bg-[var(--app-submit-background)] px-2 font-medium text-[var(--app-submit-foreground)] disabled:opacity-45" disabled={sendingAnnotations || !annotationSelection.length} onClick={() => void sendAnnotationBatch()} type="button">{sendingAnnotations ? <LoaderCircle className="size-3.5 animate-spin" /> : <MessageSquarePlus className="size-3.5" />}{t('发送所选批注到项目聊天')}</button></div>}
                      </div>
                    )}
                    <div className="mt-4 border-t border-[var(--app-border)] pt-3">
                      {browserState.previewTargets.map((target) => <button className={`mb-1 flex min-h-8 w-full items-center justify-between gap-2 rounded-md border px-2 text-left ${browserState.activePreviewTargetId === target.id ? 'border-[var(--app-focus-ring)] bg-[var(--app-active)] text-[var(--app-foreground)]' : 'border-[var(--app-control-border)] hover:bg-[var(--app-hover)]'}`} key={target.id} onClick={() => workbenchRef.current?.selectPreviewTarget(target.id)} type="button"><span className="truncate">{target.label}</span><span className="shrink-0 font-mono">:{target.port}</span></button>)}
                      <button className="flex h-7 items-center gap-1.5 rounded-md border border-[var(--app-control-border)] px-2 text-xs hover:bg-[var(--app-hover)]" onClick={() => workbenchRef.current?.refreshPreviewTargets()} type="button"><RotateCw className="size-3" />{t('刷新目标')}</button>
                    </div>
                  </div>
                </aside>
              </div>
            </div>
          ) : (
            <section className="flex min-h-0 flex-1 flex-col items-center justify-center px-6 text-center">
              <AppWindow className="size-9 text-[var(--app-muted)]" />
              <h1 className="mt-4 text-base font-medium">{t('工作区还没有代码项目')}</h1>
              <p className="mt-1 max-w-md text-sm leading-6 text-[var(--app-muted)]">{t('创建或导入一个代码项目后，就可以从这里独立打开和切换开发预览。')}</p>
              <button className="mt-4 h-8 rounded-md bg-[var(--app-submit-background)] px-3 text-sm font-medium text-[var(--app-submit-foreground)] hover:opacity-90" onClick={() => router.push(`/app/${activeWorkspace.slug}/projects`)} type="button">{t('打开项目')}</button>
            </section>
          )}
        </main>
        <OrganizationDialog onOpenChange={setOrganizationDialogOpen} open={organizationDialogOpen} />
      </div>
    </OpenLinkThemeProvider>
  )
}
