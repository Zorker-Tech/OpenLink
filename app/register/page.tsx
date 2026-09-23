import { AuthPage } from '@/components/auth-page'
import { getT } from '@/lib/i18n/server'
import { isLocalRuntime } from '@/lib/runtime-mode.server'
import type { Metadata } from 'next'

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getT()
  return { title: t('Sign up — OpenLink') }
}

export default function RegisterPage() {
  return <AuthPage localRuntime={isLocalRuntime()} mode="register" />
}
