import { AuthPage } from '@/components/auth-page'
import { safeInternalPath } from '@/lib/cross-app-auth.server'
import { getT } from '@/lib/i18n/server'
import { isLocalRuntime } from '@/lib/runtime-mode.server'
import type { Metadata } from 'next'
import { redirect } from 'next/navigation'

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getT()
  return { title: t('Sign in — OpenLink') }
}

type LoginPageProps = Readonly<{
  searchParams: Promise<Record<string, string | string[] | undefined>>
}>

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const params = await searchParams
  const next = safeInternalPath(typeof params.next === 'string' ? params.next : null, '/')
  const sharedLoginResult = typeof params.sso === 'string' ? params.sso : null
  // Local mode owns its identity domain and must render the local login form
  // directly. Cross-product SSO is only a Cloud-mode entry path.
  if (!sharedLoginResult && !isLocalRuntime()) redirect(`/auth/sso/receive?next=${encodeURIComponent(next)}`)

  return <AuthPage localRuntime={isLocalRuntime()} mode="login" />
}
