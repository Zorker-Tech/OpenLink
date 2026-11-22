import type { ComponentProps, ReactNode } from 'react'

export type OpenLinkAppShellProps = ComponentProps<'div'> & {
  navigation?: ReactNode
  overlay?: ReactNode
}

export function OpenLinkAppShell({ children, navigation, overlay, ...props }: OpenLinkAppShellProps) {
  return (
    <div {...props}>
      {navigation}
      {children}
      {overlay}
    </div>
  )
}

export type OpenLinkNavigationRailProps = ComponentProps<'nav'> & { footer?: ReactNode }

export function OpenLinkNavigationRail({ children, footer, ...props }: OpenLinkNavigationRailProps) {
  return (
    <nav {...props}>
      <div className="workspace-navigation-rail-items">{children}</div>
      {footer}
    </nav>
  )
}
