'use client'

import { ThinkingOrb } from '@/components/thinking/src'
import { AlertCircle, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

interface CodeServerWorkbenchProps {
  chatSessionId: string
}

interface CodeServerSessionResponse {
  session?: {
    url?: unknown
    expiresAt?: unknown
  }
  error?: {
    code?: unknown
  }
}

function browserReachableGatewayUrl(value: string): string {
  if (typeof window === 'undefined') return value
  try {
    const url = new URL(value)
    const loopback = new Set(['localhost', '127.0.0.1', '[::1]'])
    // During local development Agent Host binds to loopback. Match the
    // gateway hostname to the app hostname so its HttpOnly bootstrap cookie
    // remains same-site inside the code iframe (127.0.0.1 ≠ localhost).
    if (loopback.has(url.hostname) && loopback.has(window.location.hostname)) {
      url.hostname = window.location.hostname
    }
    return url.toString()
  } catch {
    return value
  }
}

export function CodeServerWorkbench({ chatSessionId }: CodeServerWorkbenchProps) {
  const [url, setUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)

  const retry = useCallback(() => {
    setUrl(null)
    setError(null)
    setAttempt((value) => value + 1)
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    setUrl(null)
    setError(null)
    void fetch('/api/code-server/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatSessionId }),
      signal: controller.signal,
      cache: 'no-store',
    }).then(async (response) => {
      const payload = await response.json().catch(() => ({})) as CodeServerSessionResponse
      const candidate = payload.session?.url
      if (!response.ok || typeof candidate !== 'string' || !candidate) {
        const code = typeof payload.error?.code === 'string' ? payload.error.code : 'CODE_SERVER_SESSION_FAILED'
        throw new Error(code)
      }
      if (!controller.signal.aborted) setUrl(browserReachableGatewayUrl(candidate))
    }).catch((reason: unknown) => {
      if (controller.signal.aborted) return
      setError(reason instanceof Error ? reason.message : 'CODE_SERVER_SESSION_FAILED')
    })
    return () => controller.abort()
  }, [attempt, chatSessionId])

  if (error) {
    return (
      <main aria-label="代码编辑器" className="flex size-full items-center justify-center bg-[#171717] p-6 text-[#e7e7e7]">
        <div className="flex max-w-sm flex-col items-center text-center">
          <span className="mb-4 flex size-10 items-center justify-center rounded-xl border border-white/10 bg-white/5"><AlertCircle className="size-5 text-[#ff9c9c]" /></span>
          <h2 className="text-sm font-medium">代码编辑器暂时无法连接</h2>
          <p className="mt-2 text-xs leading-5 text-[#9a9a9a]">{error === 'CODE_SERVER_NOT_CONFIGURED' ? '代码运行时尚未配置。' : '项目运行时正在启动或连接已过期。'}</p>
          <button className="mt-4 inline-flex h-8 items-center gap-2 rounded-md border border-white/15 px-3 text-xs text-[#d6d6d6] transition-colors hover:bg-white/10" onClick={retry} type="button"><RefreshCw className="size-3.5" />重试</button>
        </div>
      </main>
    )
  }

  if (!url) {
    return (
      <main aria-label="正在启动代码编辑器" className="flex size-full items-center justify-center bg-[#171717] text-[#b9b9b9]">
        <div className="flex flex-col items-center gap-3 text-xs">
          <ThinkingOrb aria-label="正在连接项目代码环境" className="shrink-0" size={64} state="breathing" theme="dark" />
          <span>正在连接项目代码环境…</span>
        </div>
      </main>
    )
  }

  return (
    <main aria-label="代码编辑器" className="size-full overflow-hidden bg-[#1e1e1e]">
      <iframe
        allow="clipboard-read; clipboard-write; fullscreen"
        className="block size-full border-0 bg-[#1e1e1e]"
        sandbox="allow-downloads allow-forms allow-modals allow-pointer-lock allow-popups allow-same-origin allow-scripts"
        src={url}
        title="项目代码编辑器"
      />
    </main>
  )
}
