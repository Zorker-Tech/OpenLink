import {
  useEffect,
  useId,
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
  reply?: { excerpt: string; onJump: () => void; onCancel: () => void }
  replyPlaceholder?: string
  groupMembers?: readonly { id: string; name: string }[]
  value: string
  onChange: (value: string) => void
  onSend: () => void
  onCreateRoutine?: () => void
}

export function AppComposer({
  displayName,
  disabled,
  showRoutine = true,
  status,
  reply,
  replyPlaceholder = 'Reply…',
  groupMembers,
  value,
  onChange,
  onSend,
  onCreateRoutine,
}: AppComposerProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [caret, setCaret] = useState(0)
  const [mentionIndex, setMentionIndex] = useState(0)
  const [dismissedMention, setDismissedMention] = useState<string | null>(null)
  const mentionListId = useId()
  const menuRef = useRef<HTMLDivElement>(null)
  const fieldRef = useRef<HTMLTextAreaElement>(null)
  const hasText = value.trim().length > 0
  const isReplying = reply !== undefined
  const placeholder = isReplying ? replyPlaceholder : `Message ${displayName}`
  const mention = groupMembers && !disabled && value !== dismissedMention ? /(?:^|\s)@([^@\n]{0,64})$/u.exec(value.slice(0, caret)) : null
  const query = mention?.[1]?.toLocaleLowerCase() ?? ''
  const choices = mention && query === query.trimEnd() ? [
    { id: 'everyone', name: 'Everyone', insert: 'everyone' },
    ...(groupMembers ?? []).map(({ id, name }) => ({ id, name, insert: name })),
  ].filter(({ name, insert }) => name.toLocaleLowerCase().includes(query) || insert.toLocaleLowerCase().startsWith(query)) : []
  const selectedMention = Math.min(mentionIndex, Math.max(0, choices.length - 1))

  useEffect(() => {
    const node = fieldRef.current
    if (!node) return
    node.style.height = '0px'
    // The composer grows with the content but never takes more than 40% of
    // the viewport; the transcript keeps the remaining space.
    const maxHeight = Math.max(24, Math.round(window.innerHeight * 0.4))
    node.style.height = `${Math.min(maxHeight, node.scrollHeight)}px`
  }, [isReplying, value])

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
    if (event.nativeEvent.isComposing) return
    if (choices.length && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault()
      const direction = event.key === 'ArrowDown' ? 1 : -1
      setMentionIndex((selectedMention + direction + choices.length) % choices.length)
      return
    }
    if (choices.length && event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      insertMention(choices[selectedMention]!.insert)
      return
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      submit()
    }
    if (event.key === 'Escape') {
      if (choices.length) setDismissedMention(value)
      else if (menuOpen) setMenuOpen(false)
      else reply?.onCancel()
    }
  }

  const addContext = () => {
    const next = value.length === 0 || value.endsWith(' ') ? `${value}@` : `${value} @`
    onChange(next)
    setCaret(next.length)
    setMentionIndex(0)
    setDismissedMention(null)
    setMenuOpen(false)
    window.requestAnimationFrame(() => fieldRef.current?.focus())
  }

  const insertMention = (name: string) => {
    if (!mention) return
    const start = caret - (mention[1]?.length ?? 0) - 1
    const added = `@${name} `
    const next = value.slice(0, start) + added + value.slice(caret)
    onChange(next)
    setDismissedMention(null)
    setCaret(start + added.length)
    window.requestAnimationFrame(() => {
      const field = fieldRef.current
      field?.focus({ preventScroll: true })
      field?.setSelectionRange(start + added.length, start + added.length)
    })
  }

  const createRoutine = () => {
    onCreateRoutine?.()
    setMenuOpen(false)
  }

  return (
    <div className="zbd-composer-wrap zbd-app-composer-wrap">
      {status ? <div className="zbd-composer-status">{status}</div> : null}
      <div className="zbd-composer zbd-app-composer" data-replying={isReplying ? '' : undefined}>
        {reply ? (
          <div className="zbd-app-reply-preview">
            <button className="zbd-app-reply-excerpt" onClick={reply.onJump} title={reply.excerpt} type="button">
              {reply.excerpt}
            </button>
            <button
              aria-label="Cancel reply"
              className="zbd-app-reply-cancel"
              onClick={() => {
                reply.onCancel()
                fieldRef.current?.focus({ preventScroll: true })
              }}
              type="button"
            >
              <span aria-hidden="true">×</span>
            </button>
          </div>
        ) : null}
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
                  <strong>{groupMembers ? 'Mention a member' : 'Add context'}</strong>
                  <small>{groupMembers ? 'Address someone in this group' : 'Bring in an agent or file'}</small>
                </span>
              </button>
              {showRoutine && onCreateRoutine ? (
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
          {choices.length ? (
            <ul aria-label="Group members" className="zbd-app-group-mentions" id={mentionListId} role="listbox">
              {choices.map((choice, index) => (
                <li aria-selected={index === selectedMention} id={`${mentionListId}-${index}`} key={choice.id} role="option">
                  <button onClick={() => insertMention(choice.insert)} onMouseDown={(event) => event.preventDefault()} tabIndex={-1} type="button">
                    <span aria-hidden="true">@</span> {choice.name}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          <textarea
            aria-label={placeholder}
            aria-autocomplete={groupMembers ? 'list' : undefined}
            aria-controls={choices.length ? mentionListId : undefined}
            aria-activedescendant={choices.length ? `${mentionListId}-${selectedMention}` : undefined}
            className="zbd-app-composer-input"
            disabled={disabled}
            onChange={(event) => {
              setCaret(event.currentTarget.selectionStart)
              setMentionIndex(0)
              setDismissedMention(null)
              onChange(event.currentTarget.value)
            }}
            onKeyDown={onKeyDown}
            onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
            placeholder={placeholder}
            ref={fieldRef}
            rows={1}
            value={value}
          />
        </div>
        <div className="zbd-app-composer-actions">
          <button
            aria-label="Voice message"
            className="zbd-composer-mic zbd-app-composer-mic"
            disabled={disabled}
            type="button"
          >
            <MicIcon size={15} />
          </button>
          <button
            aria-label="Send message"
            className="zbd-composer-send zbd-app-composer-send"
            data-ready={hasText ? '' : undefined}
            data-working={disabled ? '' : undefined}
            disabled={disabled || !hasText}
            onClick={submit}
            type="button"
          >
            <SendArrowIcon size={16} />
          </button>
        </div>
      </div>
    </div>
  )
}
