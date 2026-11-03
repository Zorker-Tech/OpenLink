'use client'

import { useEffect, useState } from 'react'

/**
 * Pause user-facing live surfaces after the browser tab has been hidden for a
 * short grace period. The server run is deliberately not touched; this only
 * decides whether the client keeps heavy preview transports mounted.
 */
export function useTabVisibilityPause(graceMs = 15_000): boolean {
  const [paused, setPaused] = useState(false)

  useEffect(() => {
    let timer: number | undefined
    const clear = () => {
      if (timer !== undefined) window.clearTimeout(timer)
      timer = undefined
    }
    const update = () => {
      clear()
      if (document.visibilityState !== 'hidden') {
        setPaused(false)
        return
      }
      // Avoid disconnecting on a quick alt-tab or permission prompt.
      timer = window.setTimeout(() => setPaused(true), graceMs)
    }
    update()
    document.addEventListener('visibilitychange', update)
    window.addEventListener('pagehide', update)
    window.addEventListener('pageshow', update)
    return () => {
      clear()
      document.removeEventListener('visibilitychange', update)
      window.removeEventListener('pagehide', update)
      window.removeEventListener('pageshow', update)
    }
  }, [graceMs])

  return paused
}
