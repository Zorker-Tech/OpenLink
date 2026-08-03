import { AuthPage } from '@/components/auth-page'
import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Sign in — OpenLink',
}

export default function LoginPage() {
  return <AuthPage mode="login" />
}
