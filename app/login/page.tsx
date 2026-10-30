import { AuthPage } from '@/components/auth-page'
import { getT } from '@/lib/i18n/server'
import { isLocalRuntime } from '@/lib/runtime-mode.server'
import type { Metadata } from 'next'

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getT()
  return { title: t('Sign in — OpenLink') }
}

export default function LoginPage() {
  // Cloud users authenticate with Hydite; Supabase Auth exchanges the verified
  // ID token for a native session on the shared Studio project.
  // The legacy Zorker SSO bridge remains available to explicit callers, but
  // must not be an implicit prerequisite for signing in to OpenLink.
  return <AuthPage localRuntime={isLocalRuntime()} mode="login" />
}
