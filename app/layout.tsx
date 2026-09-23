import { Analytics } from '@vercel/analytics/next'
import { OpenLinkMotionProvider } from '@/components/ui/motion-provider'
import type { Metadata, Viewport } from 'next'
import localFont from 'next/font/local'
import { resolveLocale } from '@/lib/i18n/server'
import { I18nProvider } from '@/lib/i18n/client'
import { loadMessages } from '@/lib/i18n/messages'
import { isLocalRuntime } from '@/lib/runtime-mode.server'
import './globals.css'

const geist = localFont({
  src: './fonts/geist-latin.woff2',
  display: 'swap',
})

export const metadata: Metadata = {
  title: 'OpenLink — Build full-stack web apps with AI',
  description: 'Go from idea to production with OpenLink.',
}

export const viewport: Viewport = {
  colorScheme: 'dark light',
}

// Self-hosted releases are built before an installation has a ZOKERBASE URL
// or publishable key. Render the layout at request time so the browser always
// receives the endpoint injected by the production supervisor for this
// installation, rather than an empty value frozen into the release artifact.
export const dynamic = 'force-dynamic'

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  const staticUi = process.env.OPENLINK_STATIC_UI === '1'
  const local = isLocalRuntime()
  const locale = await resolveLocale()
  const messages = await loadMessages(locale)
  const supabaseUrl = staticUi
    ? 'http://127.0.0.1:0'
    : local
      ? process.env.OPENLINK_LOCAL_ZOKERBASE_URL || process.env.OPENLINK_LOCAL_SUPABASE_URL
      : process.env.OPENLINK_CLOUD_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
  const publishableKey = staticUi
    ? 'static-ui-preview-no-backend'
    : local
      ? process.env.OPENLINK_LOCAL_ZOKERBASE_PUBLISHABLE_KEY || process.env.OPENLINK_LOCAL_SUPABASE_PUBLISHABLE_KEY
      : process.env.OPENLINK_CLOUD_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
  return (
    <html lang={locale} suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem('openlink-theme')||'system';var d=t==='dark'||(t!=='light'&&matchMedia('(prefers-color-scheme: dark)').matches);var c=document.documentElement.classList;d?c.add('dark'):c.remove('dark')}catch(e){document.documentElement.classList.add('dark')}})()`,
          }}
        />
      </head>
      <body className={`${geist.className} antialiased`}>
        <meta content={supabaseUrl || ''} name="openlink-supabase-url" />
        <meta content={publishableKey || ''} name="openlink-supabase-publishable-key" />
        <OpenLinkMotionProvider>
          <I18nProvider locale={locale} messages={messages}>{children}</I18nProvider>
        </OpenLinkMotionProvider>
        {process.env.NODE_ENV === 'production' && <Analytics />}
      </body>
    </html>
  )
}
