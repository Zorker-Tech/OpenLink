import { Analytics } from '@vercel/analytics/next'
import type { Metadata, Viewport } from 'next'
import localFont from 'next/font/local'
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
  colorScheme: 'dark',
  themeColor: '#000000',
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  const local = isLocalRuntime()
  const supabaseUrl = local
    ? process.env.OPENLINK_LOCAL_ZOKERBASE_URL || process.env.OPENLINK_LOCAL_SUPABASE_URL
    : process.env.OPENLINK_CLOUD_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
  const publishableKey = local
    ? process.env.OPENLINK_LOCAL_ZOKERBASE_PUBLISHABLE_KEY || process.env.OPENLINK_LOCAL_SUPABASE_PUBLISHABLE_KEY
    : process.env.OPENLINK_CLOUD_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
  return (
    <html className="dark" lang="zh-CN">
      <body className={`${geist.className} antialiased`}>
        <meta content={supabaseUrl || ''} name="openlink-supabase-url" />
        <meta content={publishableKey || ''} name="openlink-supabase-publishable-key" />
        {children}
        {process.env.NODE_ENV === 'production' && <Analytics />}
      </body>
    </html>
  )
}
