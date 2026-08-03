import { AuthPage } from '@/components/auth-page'
import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Sign up — OpenLink',
}

export default function RegisterPage() {
  return <AuthPage mode="register" />
}
