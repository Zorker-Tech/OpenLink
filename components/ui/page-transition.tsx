'use client'

import { motion } from 'motion/react'
import { usePathname } from 'next/navigation'
import type { ReactNode } from 'react'

/**
 * Route transition for a shell's content region only.
 *
 * The shell chrome (sidebar, topbars) lives outside this boundary, so
 * navigating between workspace surfaces never moves or re-animates it — only
 * the region the route actually replaces fades and lifts into place.
 */
export function PageTransition({ children, className }: { children: ReactNode; className?: string }) {
  const pathname = usePathname()

  return (
    <motion.div
      animate={{ opacity: 1, y: 0 }}
      className={className}
      initial={{ opacity: 0, y: 6 }}
      key={pathname}
      transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
    >
      {children}
    </motion.div>
  )
}
