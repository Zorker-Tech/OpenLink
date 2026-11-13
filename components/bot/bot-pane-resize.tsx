'use client'

import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'

type PaneResizeOptions = {
  defaultWidth: number
  minWidth: number
  maxWidth: number
  storageKey: string
}

/**
 * Width state for a right-hand side pane. The drag axis is inverted because
 * the pane grows when the pointer moves left. Widths are clamped to the
 * viewport so the chat column always keeps room, and the last width is
 * restored per pane.
 */
export function usePaneResize({ defaultWidth, minWidth, maxWidth, storageKey }: PaneResizeOptions) {
  const [width, setWidth] = useState(defaultWidth)
  const [resizing, setResizing] = useState(false)
  const widthRef = useRef(width)
  widthRef.current = width

  const clamp = useCallback((value: number) => {
    const viewportMax = typeof window === 'undefined'
      ? maxWidth
      : Math.max(minWidth, Math.min(maxWidth, window.innerWidth - 320))
    return Math.min(viewportMax, Math.max(minWidth, Math.round(value)))
  }, [maxWidth, minWidth])

  useEffect(() => {
    const saved = Number(window.localStorage.getItem(storageKey))
    if (Number.isFinite(saved) && saved > 0) setWidth(clamp(saved))
  }, [clamp, storageKey])

  const persist = useCallback((value: number) => {
    try {
      window.localStorage.setItem(storageKey, String(Math.round(value)))
    } catch {
      // Private mode or a full quota must not break the resize interaction.
    }
  }, [storageKey])

  const beginResize = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    const startX = event.clientX
    const startWidth = widthRef.current
    const previousCursor = document.body.style.cursor
    const previousSelect = document.body.style.userSelect
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    setResizing(true)

    const move = (moveEvent: PointerEvent) => {
      const next = clamp(startWidth + (startX - moveEvent.clientX))
      widthRef.current = next
      setWidth(next)
    }
    const end = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
      document.body.style.cursor = previousCursor
      document.body.style.userSelect = previousSelect
      setResizing(false)
      persist(widthRef.current)
    }

    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
  }, [clamp, persist])

  const nudge = useCallback((delta: number) => {
    setWidth((current) => {
      const next = clamp(current + delta)
      widthRef.current = next
      persist(next)
      return next
    })
  }, [clamp, persist])

  return { width, resizing, beginResize, nudge }
}

export function PaneResizeHandle({
  maxWidth,
  minWidth,
  onNudge,
  onPointerDown,
  resizing,
  width,
}: {
  maxWidth: number
  minWidth: number
  onNudge: (delta: number) => void
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void
  resizing: boolean
  width: number
}) {
  return (
    <div
      aria-label="Resize panel"
      aria-orientation="vertical"
      aria-valuemax={maxWidth}
      aria-valuemin={minWidth}
      aria-valuenow={Math.round(width)}
      className="group absolute inset-y-0 left-0 z-30 w-1.5 cursor-col-resize touch-none select-none focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--app-focus-ring)]"
      onKeyDown={(event) => {
        if (event.key === 'ArrowLeft') {
          event.preventDefault()
          onNudge(16)
        } else if (event.key === 'ArrowRight') {
          event.preventDefault()
          onNudge(-16)
        } else if (event.key === 'Home') {
          event.preventDefault()
          onNudge(minWidth - width)
        } else if (event.key === 'End') {
          event.preventDefault()
          onNudge(maxWidth - width)
        }
      }}
      onPointerDown={onPointerDown}
      role="separator"
      tabIndex={0}
    >
      <span
        aria-hidden="true"
        className={`absolute inset-y-0 left-0 w-px transition-colors ${
          resizing
            ? 'bg-[var(--app-focus-ring)]'
            : 'bg-[var(--app-border)] group-hover:bg-[var(--app-focus-ring)] group-focus-visible:bg-[var(--app-focus-ring)]'
        }`}
      />
    </div>
  )
}
