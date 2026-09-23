'use client'

import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react'
import { useEffect, useRef, useState } from 'react'
import { useT } from '@/lib/i18n/client'
import { theme } from '@/lib/theme'

export const SIDEBAR_MIN_WIDTH = 250
export const SIDEBAR_MAX_WIDTH = 280
const SIDEBAR_WIDTH_STORAGE_KEY = 'openlink-sidebar-width'

function clampSidebarWidth(width: number) {
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(width)))
}

/** Shared geometry and resize/collapse behavior for app and settings sidebars. */
export function AppSidebarFrame({ children, collapsed, mobileOpen, onCloseMobile }: {
  children: React.ReactNode
  collapsed: boolean
  mobileOpen: boolean
  onCloseMobile: () => void
}) {
  const t = useT()
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_MIN_WIDTH)
  const [isResizing, setIsResizing] = useState(false)
  const sidebarWidthRef = useRef(SIDEBAR_MIN_WIDTH)
  const dragStartRef = useRef({ pointerX: 0, width: SIDEBAR_MIN_WIDTH })

  const updateSidebarWidth = (width: number, persist = false) => {
    const nextWidth = clampSidebarWidth(width)
    sidebarWidthRef.current = nextWidth
    setSidebarWidth(nextWidth)
    if (persist) window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(nextWidth))
  }

  useEffect(() => {
    const savedWidth = Number.parseInt(window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY) ?? '', 10)
    if (Number.isFinite(savedWidth)) updateSidebarWidth(savedWidth)
  }, [])

  useEffect(() => {
    if (!isResizing) return
    const previousCursor = document.body.style.cursor
    const previousUserSelect = document.body.style.userSelect
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    const handlePointerMove = (event: PointerEvent) => updateSidebarWidth(dragStartRef.current.width + event.clientX - dragStartRef.current.pointerX)
    const handlePointerUp = () => {
      window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(sidebarWidthRef.current))
      setIsResizing(false)
    }
    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp, { once: true })
    window.addEventListener('pointercancel', handlePointerUp, { once: true })
    return () => {
      document.body.style.cursor = previousCursor
      document.body.style.userSelect = previousUserSelect
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
      window.removeEventListener('pointercancel', handlePointerUp)
    }
  }, [isResizing])

  const resizeFromPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    dragStartRef.current = { pointerX: event.clientX, width: sidebarWidthRef.current }
    setIsResizing(true)
  }

  const resizeFromKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    let nextWidth: number | null = null
    if (event.key === 'ArrowLeft') nextWidth = sidebarWidthRef.current - 4
    if (event.key === 'ArrowRight') nextWidth = sidebarWidthRef.current + 4
    if (event.key === 'Home') nextWidth = SIDEBAR_MIN_WIDTH
    if (event.key === 'End') nextWidth = SIDEBAR_MAX_WIDTH
    if (nextWidth === null) return
    event.preventDefault()
    updateSidebarWidth(nextWidth, true)
  }

  const sidebarWidthValueText = t('{width} 像素', { width: sidebarWidth })

  return (
    <>
      {mobileOpen && <button aria-label={t('关闭侧边栏')} className={`fixed inset-0 z-30 md:hidden ${theme('overlay')}`} onClick={onCloseMobile} type="button" />}
      <aside className={`fixed inset-y-0 left-0 z-40 flex w-[var(--app-sidebar-width)] shrink-0 flex-col overflow-visible border-r border-[var(--app-border)] bg-[var(--app-background)] transition-[transform,margin-left] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] md:relative ${mobileOpen ? 'translate-x-0' : '-translate-x-full'} ${collapsed ? 'md:-ml-[var(--app-sidebar-width)] md:translate-x-0 md:pointer-events-none' : 'md:ml-0 md:translate-x-0'}`} data-resizing={isResizing} style={{ '--app-sidebar-width': `${sidebarWidth}px` } as CSSProperties}>
        {children}
        <div aria-label={t('调整侧边栏宽度')} aria-orientation="vertical" aria-valuemax={SIDEBAR_MAX_WIDTH} aria-valuemin={SIDEBAR_MIN_WIDTH} aria-valuenow={sidebarWidth} aria-valuetext={sidebarWidthValueText} className="group absolute inset-y-0 -right-1.5 z-50 hidden w-3 touch-none cursor-col-resize items-center justify-center outline-none md:flex" data-resizing={isResizing} onDoubleClick={() => updateSidebarWidth(SIDEBAR_MIN_WIDTH, true)} onKeyDown={resizeFromKeyboard} onPointerDown={resizeFromPointer} role="separator" tabIndex={0} title={t('拖动调整侧边栏宽度')}>
          <span className="h-10 w-1 rounded-full bg-transparent transition-colors group-hover:bg-[var(--app-control-border)] group-focus-visible:bg-[var(--app-focus-ring)] group-data-[resizing=true]:bg-[var(--app-focus-ring)]" />
        </div>
      </aside>
    </>
  )
}
