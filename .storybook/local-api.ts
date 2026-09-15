export type ApiFixture = { body: unknown; status?: number; delay?: number }

/** Explicit per-story transport boundary. Unknown API calls fail closed. */
export function installLocalApi(fixtures: Record<string, ApiFixture>) {
  const original = window.fetch
  const pending = new Set<() => void>()
  window.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, window.location.href)
    if (!url.pathname.startsWith('/api/')) return original(input, init)
    const fixture = fixtures[url.pathname] ?? { status: 501, body: { error: { code: 'STORYBOOK_UNMOCKED_API', message: '此请求没有本地演示数据。' } } }
    if (fixture.delay) await new Promise<void>((resolve, reject) => {
      const signal = init?.signal ?? (input instanceof Request ? input.signal : null)
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); pending.delete(cancel) }
      const cancel = () => { cleanup(); reject(new DOMException('Story disposed', 'AbortError')) }
      const timer = setTimeout(() => { cleanup(); resolve() }, fixture.delay)
      pending.add(cancel)
      if (signal?.aborted) cancel()
      else signal?.addEventListener('abort', cancel, { once: true })
    })
    return Response.json(fixture.body, { status: fixture.status ?? 200 })
  }
  return () => { window.fetch = original; for (const cancel of pending) cancel(); pending.clear() }
}
