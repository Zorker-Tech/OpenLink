import { AuthPage } from '@/components/auth-page'
import { isLocalRuntime } from '@/lib/runtime-mode.server'
import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Sign up — OpenLink',
}

export default function RegisterPage() {
  return <AuthPage localRuntime={isLocalRuntime()} mode="register" />
}
