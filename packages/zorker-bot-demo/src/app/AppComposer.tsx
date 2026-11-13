import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import {
  ClockIcon,
  MicIcon,
  PlusIcon,
  SendArrowIcon,
} from '../components/icons'

export type AppComposerProps = {
  displayName: string
  disabled: boolean
  showRoutine?: boolean
  status?: ReactNode
  value: string
  onChange: (value: string) => void
  onSend: () => void
  onCreateRoutine: () => void
}

export function AppComposer({
  displayName,
  disabled,
  showRoutine = true,
  status,
  value,
  onChange,
  onSend,
  onCreateRoutine,
}: AppComposerProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const fieldRef = useRef<HTMLTextAreaElement>(null)
  const hasText = value.trim().length > 0

  useEffect(() => {
    const node = fieldRef.current
    if (!node) return
    node.style.height = '0px'
    node.style.height = `${Math.min(112, node.scrollHeight)}px`
  }, [value])

  useEffect(() => {
    if (!menuOpen) return
    const close = (event: PointerEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return
      setMenuOpen(false)
    }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [menuOpen])

  const submit = () => {
    if (disabled || !hasText) return
    onSend()
    setMenuOpen(false)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      submit()
    }
    if (event.key === 'Escape') setMenuOpen(false)
  }

  const addContext = () => {
    const next = value.length === 0 || value.endsWith(' ') ? `${value}@` : `${value} @`
    onChange(next)
    setMenuOpen(false)
    window.requestAnimationFrame(() => fieldRef.current?.focus())
  }

  const createRoutine = () => {
    onCreateRoutine()
    setMenuOpen(false)
  }

  return (
    <div className="zbd-composer-wrap zbd-app-composer-wrap">
      <div aria-hidden="true" className="zbd-composer-fade" />
      {status ? <div className="zbd-composer-status">{status}</div> : null}
      <div className="zbd-composer zbd-app-composer">
        <div className="zbd-app-composer-plus-wrap" ref={menuRef}>
          <button
            aria-expanded={menuOpen}
            aria-haspopup="menu"
            aria-label="Add context or routine"
            className="zbd-composer-plus zbd-app-composer-plus"
            disabled={disabled}
            onClick={() => setMenuOpen((open) => !open)}
            type="button"
          >
            <PlusIcon size={16} />
          </button>
          {menuOpen ? (
            <div className="zbd-app-composer-menu" role="menu">
              <button onClick={addContext} role="menuitem" type="button">
                <span className="zbd-app-menu-glyph">@</span>
                <span>
                  <strong>Add context</strong>
                  <small>Bring in an agent or file</small>
                </span>
              </button>
              {showRoutine ? (
                <button onClick={createRoutine} role="menuitem" type="button">
                  <ClockIcon size={15} />
                  <span>
                    <strong>Create a routine</strong>
                    <small>Run this on a schedule</small>
                  </span>
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
        <div className="zbd-composer-field zbd-app-composer-field">
          <textarea
            aria-label={`Message ${displayName}`}
            className="zbd-app-composer-input"
            disabled={disabled}
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder={`Message ${displayName}`}
            ref={fieldRef}
            rows={1}
            value={value}
          />
        </div>
        <button
          aria-label={hasText ? 'Send message' : 'Voice message'}
          className="zbd-composer-send zbd-app-composer-send"
          data-working={disabled ? '' : undefined}
          disabled={disabled || !hasText}
          onClick={submit}
          tabIndex={hasText ? 0 : -1}
          type="button"
        >
          {hasText ? <SendArrowIcon size={16} /> : <MicIcon size={15} />}
        </button>
      </div>
    </div>
  )
}
