import { SettingsRoute } from '@/components/settings/settings-route'
import type { ReactNode } from 'react'

export default function SettingsLayout({ children }: { children: ReactNode }) {
  return <SettingsRoute>{children}</SettingsRoute>
}
