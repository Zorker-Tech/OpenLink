'use client'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ZorkerLogo } from '@/components/zorker-logo'
import { useT } from '@/lib/i18n/client'
import { createClient } from '@/utils/supabase/client'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import type { FormEvent } from 'react'
import { useEffect, useMemo, useState } from 'react'

type AuthMode = 'login' | 'register'
type OAuthProvider = 'google' | 'github'

interface AuthPageProps {
  mode: AuthMode
  localRuntime?: boolean
}

const providers = [
  { label: 'Google', icon: '/openlink/auth/google.svg', provider: 'google' as const },
  { label: 'GitHub', icon: '/openlink/auth/github.svg', provider: 'github' as const },
] as const

function safeNextPath(value: string | null, fallback = '/') {
  return value && value.startsWith('/') && !value.startsWith('//') ? value : fallback
}

function authenticationErrorMessage(error: unknown, fallback: string) {
  const message = error instanceof Error
    ? error.message.trim()
    : typeof error === 'string'
      ? error.trim()
      : ''

  // Some transport failures from the local auth stack surface as an Error whose
  // message is a serialized empty object. That is not useful to a person and
  // must never be rendered as the login error.
  return message && message !== '{}' && message !== '[object Object]' ? message : fallback
}

export function AuthPage({ mode, localRuntime = false }: AuthPageProps) {
  const t = useT()
  const isRegister = mode === 'register'
  const isLocalRuntime = localRuntime
  const alternateBaseHref = isRegister ? '/login' : '/register'
  const alternateLabel = isRegister ? t('Sign In') : t('Sign Up')
  const router = useRouter()
  const supabase = useMemo(() => createClient(), [])
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [statusMessage, setStatusMessage] = useState<string | null>(null)
  const [nextPath, setNextPath] = useState(isRegister ? '/app' : '/')
  const alternateHref = nextPath === '/' ? alternateBaseHref : `${alternateBaseHref}?next=${encodeURIComponent(nextPath)}`

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const error = params.get('error')
    setNextPath(safeNextPath(params.get('next'), isRegister ? '/app' : '/'))

    if (error === 'auth_callback') {
      setErrorMessage(t('We could not complete sign in. Please try again.'))
    } else if (error === 'auth_confirm') {
      setErrorMessage(t('This confirmation link is invalid or has expired.'))
    } else if (params.get('sso')) {
      setStatusMessage(t('No active Zorker session was found. Sign in below to continue.'))
    }
  }, [isRegister, t])

  const shareSessionThenContinue = () => {
    if (isLocalRuntime) {
      router.replace(nextPath)
      router.refresh()
      return
    }
    const zorkerOrigin = process.env.NEXT_PUBLIC_ZORKER_APP_URL
    if (!zorkerOrigin) {
      router.replace(nextPath)
      router.refresh()
      return
    }

    const receiver = new URL('/auth/sso/receive', zorkerOrigin)
    receiver.searchParams.set('continue_to', new URL(nextPath, window.location.origin).toString())
    window.location.assign(receiver.toString())
  }

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setErrorMessage(null)
    setStatusMessage(null)

    if (isRegister && password !== confirmPassword) {
      setErrorMessage(t('Passwords do not match.'))
      return
    }

    setIsSubmitting(true)

    try {
      if (isRegister) {
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          options: {
            emailRedirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(nextPath)}${isLocalRuntime ? '' : '&share=1'}`,
          },
        })

        if (error) throw error

        if (data.session) {
          shareSessionThenContinue()
        } else {
          setStatusMessage(t('Check your email to confirm your account.'))
        }
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password })
        if (error) throw error
        shareSessionThenContinue()
      }
    } catch (error) {
      setErrorMessage(authenticationErrorMessage(
        error,
        isLocalRuntime
          ? t('Self-hosted authentication is temporarily unavailable. Check the OpenLink services, then try again.')
          : t('Unable to authenticate. Please try again.'),
      ))
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleOAuth = async (provider: OAuthProvider) => {
    setErrorMessage(null)
    setStatusMessage(null)
    setIsSubmitting(true)

    try {
      const { data, error } = await supabase.auth.signInWithOAuth({
        provider,
        options: {
          redirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(nextPath)}${isLocalRuntime ? '' : '&share=1'}`,
        },
      })
      if (error) throw error
      if (!data.url) throw new Error(t('OAuth provider did not return a redirect URL.'))
      window.location.assign(data.url)
    } catch (error) {
      setErrorMessage(authenticationErrorMessage(error, t('Unable to continue with OAuth.')))
    } finally {
      setIsSubmitting(false)
    }
  }

  const inputClassName = 'h-10 rounded-lg border-input bg-background px-3 text-base! text-foreground shadow-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/25'

  return (
    <div className="flex min-h-[100svh] flex-col overflow-hidden bg-background text-foreground">
      <header className="flex min-h-16 shrink-0 items-center px-6">
        <Link aria-label={t('Zorker home')} className="flex h-8 items-center" href="/">
          <ZorkerLogo className="h-[18px] w-[31px]" />
        </Link>
        <nav className="ml-auto flex items-center pl-8">
          <Link className="flex h-8 items-center rounded-md px-3 text-sm font-medium text-foreground transition-colors hover:bg-muted" href={alternateHref}>
            {alternateLabel}
          </Link>
        </nav>
      </header>

      <main className="flex min-h-0 flex-1 flex-col items-center justify-center gap-6 pb-8">
        <div className="flex flex-col items-center justify-center gap-4">
          <div className="flex size-20 items-center justify-center overflow-hidden rounded-full border border-border bg-muted">
            <ZorkerLogo className="h-[30px] w-[51px]" />
          </div>
          <div className="flex flex-col items-center justify-center gap-2 text-center">
            <h1 className="text-[32px] leading-10 font-semibold tracking-[-0.96px] text-foreground">Open Link</h1>
            {isRegister && (
              <p className="w-80 text-base leading-6 text-foreground">
                <span className="whitespace-nowrap">{t('We suggest using the email address you use')}</span><br />{t('at work or school')}
              </p>
            )}
          </div>
        </div>

        <div className="flex w-80 flex-col items-start gap-4">
          <form className="flex w-full flex-col gap-3" method="post" onSubmit={handleSubmit}>
            <Input
              aria-label={t('Email address')}
              autoComplete="email"
              autoFocus={isRegister}
              className={inputClassName}
              name="email"
              onChange={(event) => setEmail(event.currentTarget.value)}
              placeholder={t('name@work-email.com')}
              required
              type="email"
              value={email}
            />
            <Input
              aria-label={t('Password')}
              autoComplete={isRegister ? 'new-password' : 'current-password'}
              className={inputClassName}
              minLength={6}
              name="password"
              onChange={(event) => setPassword(event.currentTarget.value)}
              placeholder={t('Password')}
              required
              type="password"
              value={password}
            />
            {isRegister && (
              <Input
                aria-label={t('Confirm password')}
                autoComplete="new-password"
                className={inputClassName}
                minLength={6}
                name="confirmPassword"
                onChange={(event) => setConfirmPassword(event.currentTarget.value)}
                placeholder={t('Confirm password')}
                required
                type="password"
                value={confirmPassword}
              />
            )}
            <Button className="h-10 w-full rounded-lg" disabled={isSubmitting} type="submit">
              {isSubmitting ? t('Please wait…') : t('Continue with Email')}
            </Button>
          </form>

          {(errorMessage || statusMessage) && (
            <p className={`w-full text-center text-sm leading-5 ${errorMessage ? 'text-destructive' : 'text-muted-foreground'}`} role={errorMessage ? 'alert' : 'status'}>
              {errorMessage || statusMessage}
            </p>
          )}

          {isLocalRuntime ? (
            <p className="w-full text-center text-sm leading-5 text-muted-foreground">
              {t('Self-hosted OpenLink uses email and password.')}
            </p>
          ) : (
            <>
              <div className="h-px w-full border-t border-border" />

              <div className="flex w-full flex-col gap-4">
                {providers.map((provider, index) => (
                  <div className="relative w-full" key={provider.label}>
                    <Button className="h-10 w-full rounded-lg px-3.5 text-base font-medium" disabled={isSubmitting} onClick={() => handleOAuth(provider.provider)} type="button" variant="outline">
                      <img alt="" className="size-5" src={provider.icon} />
                      {t('Continue with {provider}', { provider: provider.label })}
                    </Button>
                    {index === 0 && (
                      <span className="absolute -top-2 -right-2 flex h-5 items-center rounded-full bg-primary px-2 text-[11px] leading-5 font-medium tracking-[0.2px] text-primary-foreground">
                        {t('Last Used')}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        <p className="text-center text-base leading-6 text-foreground">
          {isRegister ? t('Already have an account?') : t("Don't have an account?")}{' '}
          <Link className="text-primary hover:underline" href={alternateHref}>{alternateLabel}</Link>
        </p>
      </main>

      <footer className="shrink-0 px-4 text-center text-xs leading-4 text-muted-foreground">
        {t('By proceeding, you agree to creating an Open Link account subject to our')}{' '}
        <a className="text-foreground hover:underline" href="#terms">{t('Terms of Service')}</a>{' '}{t('and')}{' '}
        <a className="text-foreground hover:underline" href="#privacy">{t('Privacy Policy')}</a>.
      </footer>
    </div>
  )
}
