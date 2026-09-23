'use client'

import { useCallback, useEffect, useState } from 'react'

const STORAGE_KEY = 'openlink-sidebar-collapsed'

/**
 * Sidebar collapse state that survives navigation between shells.
 *
 * Every workspace surface renders its own shell, so without this the sidebar
 * snapped back to expanded — and visibly moved — on each route change.
 */
export function useSidebarCollapsed() {
  const [collapsed, setCollapsed] = useState(false)

  useEffect(() => {
    try {
      setCollapsed(window.localStorage.getItem(STORAGE_KEY) === '1')
    } catch {
      // Private-mode storage failures keep the expanded default.
    }
  }, [])

  const update = useCallback((value: boolean | ((current: boolean) => boolean)) => {
    setCollapsed((current) => {
      const next = typeof value === 'function' ? value(current) : value
      try {
        window.localStorage.setItem(STORAGE_KEY, next ? '1' : '0')
      } catch {
        // Persisting is best-effort; the in-memory state still applies.
      }
      return next
    })
  }, [])

  return [collapsed, update] as const
}
