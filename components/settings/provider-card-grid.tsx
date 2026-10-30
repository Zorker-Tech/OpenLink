import type { ReactNode } from 'react'

/** Shared responsive layout for provider cards. Breakpoints change columns only. */
export function ProviderCardGrid({ children }: { children: ReactNode }) {
  return (
    <div className="grid w-full grid-flow-row grid-cols-[repeat(auto-fill,320px)] justify-start gap-x-4 gap-y-4">
      {children}
    </div>
  )
}
