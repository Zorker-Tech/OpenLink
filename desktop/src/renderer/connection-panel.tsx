import { useCallback, useEffect, useState } from 'react'

import {
  desktopBridge,
  type DesktopProfile,
  type DesktopProfileKind,
  type DesktopState,
} from './platform/desktop-bridge'

type Message = { kind: 'ok' | 'error'; text: string } | null

const inputClass =
  'h-9 w-full rounded-md border border-border bg-background px-2.5 text-sm text-foreground outline-none focus:border-foreground/40'
const buttonClass =
  'inline-flex h-8 items-center justify-center rounded-md border border-border px-3 text-xs font-medium text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50'
const primaryButtonClass =
  'inline-flex h-8 items-center justify-center rounded-md bg-foreground px-3 text-xs font-medium text-background transition-opacity hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-50'

function kindLabel(kind: DesktopProfileKind) {
  return kind === 'cloud' ? 'Cloud' : 'Self-hosted'
}

function ProfileRow({
  profile,
  active,
  busy,
  onActivate,
  onRemove,
}: {
  profile: DesktopProfile
  active: boolean
  busy: boolean
  onActivate: () => void
  onRemove: () => void
}) {
  return (
    <div className={`rounded-lg border p-3 ${active ? 'border-foreground/30 bg-muted/40' : 'border-border'}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium">{profile.name}</span>
            <span className="rounded border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
              {kindLabel(profile.kind)}
            </span>
            {active && <span className="text-[10px] font-medium uppercase tracking-wide text-emerald-600 dark:text-emerald-400">Active</span>}
          </div>
          <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
            {profile.upstreamUrl}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {!active && (
            <button className={primaryButtonClass} disabled={busy} onClick={onActivate} type="button">
              Switch
            </button>
          )}
          <button className={buttonClass} disabled={busy || active} onClick={onRemove} type="button">
            Remove
          </button>
        </div>
      </div>
    </div>
  )
}

export function DesktopConnectionPanel({
  open,
  onClose,
}: {
  open: boolean
  onClose: () => void
}) {
  const bridge = desktopBridge()
  const [state, setState] = useState<DesktopState | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [message, setMessage] = useState<Message>(null)
  const [kind, setKind] = useState<'remote' | 'cloud'>('remote')
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')

  const refresh = useCallback(async () => {
    if (!bridge) return
    setState(await bridge.getState())
  }, [bridge])

  useEffect(() => {
    if (!open) return
    void refresh().catch((error) =>
      setMessage({ kind: 'error', text: error instanceof Error ? error.message : 'Failed to load desktop state' }),
    )
    const off = bridge?.onStateChanged((next) => setState(next))
    return () => off?.()
  }, [open, refresh, bridge])

  if (!open) return null

  const active = state?.profiles.find((profile) => profile.id === state.activeProfileId) ?? null

  const run = async (label: string, action: () => Promise<unknown>) => {
    setBusy(label)
    setMessage(null)
    try {
      const result = (await action()) as { ok?: boolean; error?: string } | null
      if (result && result.ok === false) {
        setMessage({ kind: 'error', text: result.error || `${label} failed` })
      } else {
        setMessage({ kind: 'ok', text: `${label} completed` })
      }
    } catch (error) {
      setMessage({ kind: 'error', text: error instanceof Error ? error.message : `${label} failed` })
    } finally {
      setBusy(null)
      await refresh().catch(() => undefined)
    }
  }

  const switchProfile = async (profile: DesktopProfile) => {
    if (!bridge) return
    setBusy(`Switching to ${profile.name}`)
    setMessage(null)
    try {
      await bridge.activateProfile(profile.id)
    } catch {
      // The renderer is normally destroyed while switching; a rejected IPC is
      // expected and the new window reports its own state.
    }
  }

  const addProfile = async () => {
    if (!bridge || !url.trim()) return
    setBusy('Add server')
    setMessage(null)
    try {
      const profile = await bridge.upsertProfile({
        kind,
        name: name.trim() || (kind === 'cloud' ? 'Cloud' : 'Self-hosted'),
        upstreamUrl: url.trim(),
      })
      const next = await bridge.getState()
      setName('')
      setUrl('')
      if (!next.activeProfileId) {
        // First server: connect immediately so the setup surface becomes the
        // product UI instead of leaving the user on an empty state.
        await bridge.activateProfile(profile.id)
        return
      }
      setState(next)
      setMessage({ kind: 'ok', text: `${profile.name} added. Use Switch to connect.` })
    } catch (error) {
      setMessage({ kind: 'error', text: error instanceof Error ? error.message : 'Unable to add the server' })
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="fixed inset-0 z-[100] flex justify-end bg-black/40" role="dialog" aria-modal="true">
      <button aria-label="Close" className="absolute inset-0 cursor-default" onClick={onClose} type="button" />
      <aside className="relative flex h-full w-full max-w-[520px] flex-col overflow-y-auto border-l border-border bg-background p-5 text-foreground shadow-2xl">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold">OpenLink Desktop</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Connect to your Cloud or self-hosted OpenLink instances.
            </p>
          </div>
          <button className={buttonClass} onClick={onClose} type="button">Close</button>
        </div>

        {!bridge && (
          <p className="mt-4 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300">
            Connection management is only available in the Electron shell.
          </p>
        )}

        {message && (
          <p
            className={`mt-4 rounded-md border p-2 text-xs ${
              message.kind === 'error'
                ? 'border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300'
                : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
            }`}
          >
            {message.text}
          </p>
        )}

        {bridge && state && (
          <>
            <section className="mt-5">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Servers</h3>
              {state.profiles.length === 0 ? (
                <p className="mt-2 rounded-lg border border-dashed border-border p-3 text-sm text-muted-foreground">
                  No server connected yet. Add a Cloud or self-hosted instance below.
                </p>
              ) : (
                <div className="mt-2 space-y-2">
                  {state.profiles.map((profile) => (
                    <ProfileRow
                      active={profile.id === state.activeProfileId}
                      busy={Boolean(busy)}
                      key={profile.id}
                      onActivate={() => void switchProfile(profile)}
                      onRemove={() => void run('Remove server', () => bridge.removeProfile(profile.id))}
                      profile={profile}
                    />
                  ))}
                </div>
              )}
            </section>

            <section className="mt-5 rounded-lg border border-border p-3">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Add a server</h3>
              <div className="mt-2 flex gap-1.5">
                <button className={kind === 'remote' ? primaryButtonClass : buttonClass} onClick={() => setKind('remote')} type="button">Self-hosted</button>
                <button className={kind === 'cloud' ? primaryButtonClass : buttonClass} onClick={() => setKind('cloud')} type="button">Cloud</button>
              </div>
              <div className="mt-2 space-y-2">
                <input className={inputClass} onChange={(event) => setName(event.target.value)} placeholder="Name" value={name} />
                <input className={inputClass} onChange={(event) => setUrl(event.target.value)} placeholder="https://openlink.example.com" value={url} />
                <button
                  className={primaryButtonClass}
                  disabled={Boolean(busy) || !url.trim()}
                  onClick={() => void addProfile()}
                  type="button"
                >
                  Add server
                </button>
              </div>
            </section>

            <section className="mt-5 rounded-lg border border-border p-3">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Active server</h3>
              <p className="mt-1 text-sm">{active ? `${active.name} · ${kindLabel(active.kind)}` : 'None'}</p>
              {active && (
                <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground">{active.upstreamUrl}</p>
              )}
              {!active && (
                <p className="mt-1 text-xs text-muted-foreground">
                  Add and switch to a server to open the product.
                </p>
              )}
            </section>

            <p className="mt-6 text-[11px] leading-5 text-muted-foreground">
              Electron {state.versions.electron} · Chromium {state.versions.chrome} · Node {state.versions.node}
            </p>
          </>
        )}
      </aside>
    </div>
  )
}
