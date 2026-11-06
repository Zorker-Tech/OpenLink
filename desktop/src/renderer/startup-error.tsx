import { useEffect, useState } from 'react'

import { DesktopConnectionPanel } from './connection-panel'
import {
  desktopBridge,
  type DesktopProfile,
  type DesktopState,
} from './platform/desktop-bridge'

/**
 * First-run and recovery surface.
 *
 * A desktop installation can start without a server (first run) or with an
 * unreachable Cloud/self-hosted server. Keep the connection manager available
 * even though the renderer could not fetch capabilities.
 */
export function DesktopStartupError({ error }: { error: unknown }) {
  const bridge = desktopBridge()
  const [state, setState] = useState<DesktopState | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [connectionsOpen, setConnectionsOpen] = useState(false)

  const active: DesktopProfile | null =
    state?.profiles.find((profile) => profile.id === state.activeProfileId) ?? null

  useEffect(() => {
    if (!bridge) return
    void bridge
      .getState()
      .then(setState)
      .catch((cause) => {
        setMessage(cause instanceof Error ? cause.message : 'Desktop state is unavailable')
      })
    // The bridge is stable for the lifetime of the window.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <main className="flex min-h-dvh items-center justify-center bg-background p-8 text-foreground">
      <div className="w-full max-w-xl rounded-2xl border border-border bg-card p-6 shadow-xl sm:p-8">
        <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
          OpenLink Desktop
        </p>
        <h1 className="mt-3 text-2xl font-semibold tracking-[-0.03em]">
          {active ? 'This OpenLink instance is not reachable' : 'Connect an OpenLink server'}
        </h1>
        <p className="mt-2 break-words text-sm leading-6 text-muted-foreground">
          {active
            ? error instanceof Error
              ? error.message
              : 'The desktop could not reach its OpenLink server.'
            : 'OpenLink Desktop is a client for Cloud and self-hosted instances. Add a server to continue.'}
        </p>

        {active && (
          <div className="mt-5 rounded-lg border border-border p-3 text-sm">
            <div className="flex items-center justify-between gap-3">
              <span className="font-medium">{active.name}</span>
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                {active.kind === 'cloud' ? 'Cloud' : 'Self-hosted'}
              </span>
            </div>
            <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
              {active.upstreamUrl}
            </p>
          </div>
        )}

        {message && (
          <p className="mt-3 rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-xs text-amber-700 dark:text-amber-300">
            {message}
          </p>
        )}

        <div className="mt-6 flex flex-wrap gap-2">
          {active && (
            <button
              className="inline-flex h-9 items-center rounded-md bg-foreground px-4 text-sm font-medium text-background"
              onClick={() => void bridge?.openExternal(active.upstreamUrl)}
              type="button"
            >
              Open in browser
            </button>
          )}
          <button
            className="inline-flex h-9 items-center rounded-md border border-border px-4 text-sm font-medium hover:bg-muted"
            onClick={() => window.location.reload()}
            type="button"
          >
            Retry
          </button>
          {bridge && (
            <button
              className="inline-flex h-9 items-center rounded-md border border-border px-4 text-sm font-medium hover:bg-muted"
              onClick={() => setConnectionsOpen(true)}
              type="button"
            >
              Connections…
            </button>
          )}
        </div>
      </div>
      <DesktopConnectionPanel
        open={connectionsOpen}
        onClose={() => setConnectionsOpen(false)}
      />
    </main>
  )
}
