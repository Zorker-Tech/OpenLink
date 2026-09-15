"use client"

import { useLayoutEffect, useRef, type ReactNode } from 'react'
import { gsap } from 'gsap'
import styles from './work-model-selector.module.css'

/** Animate intrinsic content height without scaling text or delaying selection. */
export function WorkModelSelectorMotion({ children, view }: { children: ReactNode; view: 'models' | 'effort' }) {
  const viewportRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const viewport = viewportRef.current
    const content = contentRef.current
    if (!viewport || !content) return
    const media = gsap.matchMedia()
    media.add({ reduce: '(prefers-reduced-motion: reduce)', full: '(prefers-reduced-motion: no-preference)' }, context => {
      let lastHeight = content.offsetHeight
      gsap.set(viewport, { height: lastHeight })
      // Register asynchronous observer work with the media context for cleanup.
      context.add('resize', () => {
        const nextHeight = content.offsetHeight
        if (nextHeight === lastHeight) return
        lastHeight = nextHeight
        gsap.to(viewport, { height: nextHeight, duration: context.conditions?.reduce ? 0 : .22, ease: 'power3.out', overwrite: true })
      })
      const observer = new ResizeObserver(() => context.resize())
      observer.observe(content)
      return () => observer.disconnect()
    }, viewport)
    return () => media.revert()
  }, [])

  useLayoutEffect(() => {
    const content = contentRef.current
    if (!content) return
    const media = gsap.matchMedia()
    media.add('(prefers-reduced-motion: no-preference)', () => {
      gsap.fromTo(content, { opacity: .55, y: view === 'models' ? -4 : 4 }, {
        opacity: 1, y: 0, duration: .18, ease: 'power2.out', clearProps: 'opacity,transform',
      })
    }, content)
    return () => media.revert()
  }, [view])

  return <div ref={viewportRef} className={styles.motionViewport} data-selector-view={view}>
    <div ref={contentRef}>{children}</div>
  </div>
}
