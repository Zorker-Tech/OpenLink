'use client'

import { AnimatePresence, MotionConfig, motion } from 'motion/react'
import { usePathname } from 'next/navigation'
import type { ReactNode } from 'react'

const pageTransition = {
  duration: 0.18,
  ease: [0.22, 1, 0.36, 1] as const,
}

/**
 * Shared motion boundary for the web app.
 *
 * Keeping this at the root gives every OpenLink surface the same reduced-motion
 * contract and a small, deterministic route transition. Component-level
 * interactions can still opt into their own layout/gesture animations without
 * inventing a second timing system.
 */
export function OpenLinkMotionProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname()

  return (
    <MotionConfig reducedMotion="user">
      <AnimatePresence initial={false} mode="wait">
        <motion.div
          animate={{ opacity: 1, y: 0 }}
          className="openlink-motion-page"
          exit={{ opacity: 0, y: -4 }}
          initial={{ opacity: 0, y: 6 }}
          key={pathname}
          transition={pageTransition}
        >
          {children}
        </motion.div>
      </AnimatePresence>
    </MotionConfig>
  )
}
