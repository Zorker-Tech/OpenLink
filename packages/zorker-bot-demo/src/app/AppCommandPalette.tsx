import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react'
import { AgentAvatar } from '../components/AgentAvatar'
import { PlusIcon } from '../components/icons'
import { isSessionMatch, sessionToAgent, type AppSession } from './data'

export type PaletteSession = {
  session: AppSession
  name: string
}

type PaletteItem =
  | { kind: 'create'; key: string }
  | { kind: 'session'; key: string; session: AppSession; name: string }

export type AppCommandPaletteProps = {
  sessions: PaletteSession[]
  query: string
  assetBase: string
  onQueryChange: (value: string) => void
  onClose: () => void
  onSelect: (sessionId: string) => void
  onCreate: (query: string) => void
}

export function AppCommandPalette({
  sessions,
  query,
  assetBase,
  onQueryChange,
  onClose,
  onSelect,
  onCreate,
}: AppCommandPaletteProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [activeIndex, setActiveIndex] = useState(0)

  const filtered = sessions.filter(({ session, name }) =>
    isSessionMatch(session, query, name),
  )
  const createItem: PaletteItem = { kind: 'create', key: 'create' }
  const sessionItems: PaletteItem[] = filtered.map(({ session, name }) => ({
    kind: 'session',
    key: session.id,
    session,
    name,
  }))
  const items =
    query.trim().length > 0
      ? [...sessionItems, createItem]
      : [createItem, ...sessionItems]

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    setActiveIndex(0)
  }, [query])

  useEffect(() => {
    const onEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onEscape)
    return () => document.removeEventListener('keydown', onEscape)
  }, [onClose])

  const activate = (item: PaletteItem) => {
    if (item.kind === 'create') {
      onCreate(query.trim())
    } else {
      onSelect(item.session.id)
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActiveIndex((index) => Math.min(items.length - 1, index + 1))
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex((index) => Math.max(0, index - 1))
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      const item = items[activeIndex]
      if (item) activate(item)
    }
  }

  const createLabel =
    query.trim().length > 0
      ? `Create “${query.trim()}”`
      : 'Create new agent'

  return (
    <div className="zbd-app-palette-layer">
      <button
        aria-label="Close agent search"
        className="zbd-app-palette-scrim"
        onClick={onClose}
        type="button"
      />
      <div
        aria-label="Search or create agents"
        aria-modal="false"
        className="zbd-app-palette"
        role="dialog"
      >
        <div className="zbd-app-palette-search">
          <span className="zbd-app-palette-to">To:</span>
          <input
            aria-label="Search or create agents"
            onChange={(event) => onQueryChange(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search or create agents"
            ref={inputRef}
            type="text"
            value={query}
          />
        </div>
        <div className="zbd-app-palette-list" role="listbox">
          {items.map((item, index) => {
            const active = index === activeIndex
            if (item.kind === 'create') {
              return (
                <button
                  aria-selected={active}
                  className="zbd-app-palette-row"
                  data-active={active ? '' : undefined}
                  key={item.key}
                  onClick={() => activate(item)}
                  onMouseEnter={() => setActiveIndex(index)}
                  role="option"
                  type="button"
                >
                  <span className="zbd-app-palette-create-icon">
                    <PlusIcon size={15} />
                  </span>
                  <span className="zbd-app-palette-row-name">
                    {createLabel}
                  </span>
                </button>
              )
            }

            const agent = sessionToAgent(item.session, item.name)
            return (
              <button
                aria-selected={active}
                className="zbd-app-palette-row"
                data-active={active ? '' : undefined}
                key={item.key}
                onClick={() => activate(item)}
                onMouseEnter={() => setActiveIndex(index)}
                role="option"
                type="button"
              >
                <AgentAvatar agent={agent} assetBase={assetBase} size={22} />
                <span className="zbd-app-palette-row-name">{item.name}</span>
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}
