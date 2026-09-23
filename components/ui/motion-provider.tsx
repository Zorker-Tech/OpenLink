'use client'

import { MotionConfig } from 'motion/react'
import type { ReactNode } from 'react'

/**
 * Shared motion boundary for the web app.
 *
 * This is intentionally *not* a page-transition wrapper: animating the whole
 * document made the persistent chrome (sidebar, topbars) slide on every
 * navigation. Route transitions belong to `PageTransition`, which each shell
 * applies to its content region only. What remains here is the reduced-motion
 * contract every surface inherits.
 */
export function OpenLinkMotionProvider({ children }: { children: ReactNode }) {
  return <MotionConfig reducedMotion="user">{children}</MotionConfig>
}

