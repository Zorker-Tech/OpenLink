import type { ReactNode } from 'react'

export function ProviderCardGrid({ children }: { children: ReactNode }) {
  return (
    <div className="settings-provider-card-grid">
      {children}
    </div>
  )
}
