import { SettingsRoute } from '@/components/settings/settings-route'
import type { ReactNode } from 'react'

export default function InterceptedSettingsLayout({ children }: { children: ReactNode }) {
  return <SettingsRoute intercepted>{children}</SettingsRoute>
}
