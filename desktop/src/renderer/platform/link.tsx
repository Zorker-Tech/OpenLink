import type { AnchorHTMLAttributes, MouseEvent, ReactNode } from 'react'

import { useDesktopRouter } from '../router'

export interface DesktopLinkProps
  extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> {
  href: string
  children?: ReactNode
  replace?: boolean
  scroll?: boolean
  prefetch?: boolean
}

/**
 * `next/link` replacement. The shared UI uses plain string hrefs and passes
 * ordinary anchor attributes, so a small client-side navigation wrapper is
 * enough to preserve behavior in the Vite host.
 */
export default function Link({
  href,
  replace,
  scroll: _scroll,
  prefetch: _prefetch,
  onClick,
  target,
  children,
  ...rest
}: DesktopLinkProps) {
  const router = useDesktopRouter()

  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event)
    if (event.defaultPrevented) return
    if (event.button !== 0) return
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    if (target && target !== '_self') return
    if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) return
    try {
      if (new URL(href, window.location.href).origin !== window.location.origin) return
    } catch {
      return
    }
    event.preventDefault()
    if (replace) router.replace(href)
    else router.push(href)
  }

  return (
    <a href={href} target={target} onClick={handleClick} {...rest}>
      {children}
    </a>
  )
}

export { Link }
