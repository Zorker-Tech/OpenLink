'use client'

import { useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { formatTime } from '../lib/format-time'
import type { MessageReaction, TranscriptEntry } from '../types'
import { EmojiPicker } from './EmojiPicker'
import { RichText } from './RichText'

type MessageEntry = Extract<TranscriptEntry, { kind: 'agent-message' | 'user-message' }>

export type MessageMenuActions = {
  entry: MessageEntry
  copy: (content?: string) => void
  react?: (emoji: string) => void
  reply?: () => void
  openEmojiPicker: () => void
}

export type MessageToolbarActions = Omit<MessageMenuActions, 'openEmojiPicker'> & {
  copied: boolean
  pickerOpen: boolean
  toggleEmojiPicker: (anchor: HTMLElement) => void
}

export type MessageBubbleProps = {
  entry: MessageEntry
  assetBase: string
  showTimestamp?: boolean
  timestampLabel?: string
  renderContent?: (content: string) => ReactNode
  renderUserContent?: (content: string) => ReactNode
  /** Where this message sits in a consecutive run by the same author. */
  groupPosition?: 'single' | 'start' | 'middle' | 'end'
  /** Toggle a reaction on this message. Omit to keep the transcript read-only. */
  onReact?: (entry: MessageEntry, emoji: string) => void
  onReply?: () => void
  renderActions?: (actions: MessageToolbarActions) => ReactNode
  renderMenu?: (bubble: ReactElement, actions: MessageMenuActions) => ReactNode
}

type ReactionGroup = { emoji: string; by: string[] }

/** Collapse `{emoji, by}` rows into one chip per emoji, preserving order. */
function groupReactions(reactions: readonly MessageReaction[]): ReactionGroup[] {
  const groups: ReactionGroup[] = []
  const index = new Map<string, number>()
  for (const reaction of reactions) {
    const emoji = reaction.emoji.trim()
    if (!emoji) continue
    const at = index.get(emoji)
    if (at === undefined) {
      index.set(emoji, groups.length)
      groups.push({ emoji, by: [reaction.by] })
    } else if (!groups[at].by.includes(reaction.by)) {
      groups[at].by.push(reaction.by)
    }
  }
  return groups
}

function authorLabel(by: string): string {
  return by === 'me' ? 'You' : by
}

async function copyMessage(content: string) {
  if (navigator.clipboard) {
    await navigator.clipboard.writeText(content)
    return true
  }
  const field = document.createElement('textarea')
  const focused = document.activeElement
  field.value = content
  field.style.cssText = 'position: fixed; inset: 0 auto auto 0; opacity: 0; pointer-events: none'
  document.body.append(field)
  try {
    field.select()
    return document.execCommand('copy')
  } finally {
    field.remove()
    if (focused instanceof HTMLElement) focused.focus({ preventScroll: true })
  }
}

function SmileIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16">
      <circle cx="8" cy="8" fill="none" r="5.9" stroke="currentColor" strokeWidth="1.25" />
      <circle cx="6" cy="6.6" fill="currentColor" r="0.85" />
      <circle cx="10" cy="6.6" fill="currentColor" r="0.85" />
      <path d="M5.4 9.3c.6.9 1.5 1.4 2.6 1.4s2-.5 2.6-1.4" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.25" />
    </svg>
  )
}

function CopyIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16">
      <rect fill="none" height="8.2" rx="2" stroke="currentColor" strokeWidth="1.25" width="8.2" x="5.4" y="5.4" />
      <path d="M10.4 5.2V4.2A2.2 2.2 0 0 0 8.2 2H4.2A2.2 2.2 0 0 0 2 4.2v4c0 1.2 1 2.2 2.2 2.2h1" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.25" />
    </svg>
  )
}

function ReplyIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16">
      <path d="M6.5 3.5 3 7l3.5 3.5M3.2 7H9a4 4 0 0 1 4 4v1" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.3" />
    </svg>
  )
}

function CheckIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16">
      <path d="m3.5 8.4 2.8 2.8 6.2-6.4" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" />
    </svg>
  )
}

export function MessageBubble({
  entry,
  assetBase,
  showTimestamp = false,
  timestampLabel,
  renderContent,
  renderUserContent,
  groupPosition = 'single',
  onReact,
  onReply,
  renderActions,
  renderMenu,
}: MessageBubbleProps) {
  const isUser = entry.kind === 'user-message'
  const groups = useMemo(() => groupReactions(entry.reactions ?? []), [entry.reactions])
  const [reactionState, setReactionState] = useState({ current: groups, rendered: groups })
  if (reactionState.current !== groups) {
    const nextByEmoji = new Map(groups.map((group) => [group.emoji, group]))
    const rendered = reactionState.rendered.map((group) => {
      const updated = nextByEmoji.get(group.emoji)
      nextByEmoji.delete(group.emoji)
      return updated ?? group
    })
    setReactionState({ current: groups, rendered: [...rendered, ...nextByEmoji.values()] })
  }
  const attachment = entry.attachment
  const markdown = !attachment && !isUser && renderContent !== undefined
  const [pickerOpen, setPickerOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const bubbleWrapRef = useRef<HTMLDivElement>(null)
  const reactButtonRef = useRef<HTMLButtonElement>(null)
  const pickerAnchorRef = useRef<HTMLElement | null>(null)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => {
    if (copyTimer.current) clearTimeout(copyTimer.current)
  }, [])

  const copy = (content = entry.content) => {
    void copyMessage(content).then((didCopy) => {
      if (!didCopy) return
      if (content !== entry.content) return
      setCopied(true)
      if (copyTimer.current) clearTimeout(copyTimer.current)
      copyTimer.current = setTimeout(() => setCopied(false), 1_600)
    }).catch(() => undefined)
  }

  const bubble = (
    <div
      className={`${isUser ? 'zbd-bubble zbd-bubble-user' : 'zbd-bubble zbd-bubble-agent'}${markdown ? ' zbd-bubble-markdown' : ''}`}
      data-group-position={groupPosition}
    >
      {attachment ? (
        <div className="zbd-attachment-card" data-kind={attachment.kind}>
          <span aria-hidden="true" className="zbd-attachment-format">
            {attachment.name.match(/\.([a-z0-9]{1,5})$/i)?.[1]?.toUpperCase() ?? (attachment.kind === 'media' ? 'MEDIA' : 'FILE')}
          </span>
          <span className="zbd-attachment-name" title={attachment.name}>{attachment.name}</span>
        </div>
      ) : isUser ? renderUserContent?.(entry.content) ?? entry.content : renderContent ? renderContent(entry.content) : <RichText assetBase={assetBase} content={entry.content} />}
    </div>
  )
  const react = onReact ? (emoji: string) => onReact(entry, emoji) : undefined
  const menuActions = {
    entry, copy, react, reply: onReply,
    openEmojiPicker: () => {
      pickerAnchorRef.current = null
      setPickerOpen(true)
    },
  }

  return (
    <>
      {showTimestamp ? (
        <div className="zbd-time-separator" suppressHydrationWarning>
          {timestampLabel ?? formatTime(entry.timestampMs)}
        </div>
      ) : null}
      <div className={isUser ? 'zbd-message-row zbd-message-row-user' : 'zbd-message-row'}>
        <div className={isUser ? 'zbd-bubble-wrap zbd-bubble-wrap-user' : 'zbd-bubble-wrap'} ref={bubbleWrapRef}>
          {!renderActions && (onReact || onReply || entry.content) ? (
            <div className="zbd-message-actions" data-side={isUser ? 'user' : 'agent'}>
              {onReact ? (
                <button
                  aria-expanded={pickerOpen}
                  aria-haspopup="dialog"
                  aria-label="Add a reaction"
                  className="zbd-message-action"
                  onClick={() => setPickerOpen((open) => !open)}
                  ref={reactButtonRef}
                  title="Add a reaction"
                  type="button"
                >
                  <SmileIcon />
                </button>
              ) : null}
              {onReply ? (
                <button aria-label="Reply" className="zbd-message-action" onClick={onReply} title="Reply" type="button">
                  <ReplyIcon />
                </button>
              ) : null}
              <button
                aria-label={copied ? 'Copied' : 'Copy message'}
                className="zbd-message-action"
                onClick={() => copy()}
                title={copied ? 'Copied' : 'Copy message'}
                type="button"
              >
                {copied ? <CheckIcon /> : <CopyIcon />}
              </button>
            </div>
          ) : null}
          {renderMenu ? renderMenu(bubble, menuActions) : bubble}
          {reactionState.rendered.length > 0 ? (
            <span className={isUser ? 'zbd-reactions zbd-reactions-user' : 'zbd-reactions zbd-reactions-agent'}>
              {reactionState.rendered.map((group) => {
                const mine = group.by.includes('me')
                const leaving = !groups.some(({ emoji }) => emoji === group.emoji)
                return (
                  <button
                    aria-hidden={leaving || undefined}
                    aria-label={`${group.emoji} reaction from ${group.by.map(authorLabel).join(', ')}`}
                    aria-pressed={mine}
                    className={mine ? 'zbd-reaction zbd-reaction-mine' : 'zbd-reaction'}
                    data-leaving={leaving || undefined}
                    disabled={leaving}
                    key={group.emoji}
                    onAnimationEnd={(event) => {
                      if (!leaving || event.target !== event.currentTarget || event.animationName !== 'zbd-reaction-exit') return
                      setReactionState((state) => state.current.some(({ emoji }) => emoji === group.emoji)
                        ? state
                        : { ...state, rendered: state.rendered.filter(({ emoji }) => emoji !== group.emoji) })
                    }}
                    onClick={() => react?.(group.emoji)}
                    title={group.by.map(authorLabel).join(', ')}
                    type="button"
                  >
                    <span className="zbd-reaction-emoji">{group.emoji}</span>
                    {group.by.length > 1 ? <span className="zbd-reaction-count">{group.by.length}</span> : null}
                  </button>
                )
              })}
            </span>
          ) : null}
          {renderActions ? renderActions({
            ...menuActions,
            copied,
            pickerOpen,
            toggleEmojiPicker: (anchor) => {
              pickerAnchorRef.current = anchor
              setPickerOpen((open) => !open)
            },
          }) : null}
          {pickerOpen && onReact ? (
            <EmojiPicker
              anchor={pickerAnchorRef.current ?? reactButtonRef.current ?? bubbleWrapRef.current}
              onClose={() => setPickerOpen(false)}
              onPick={(emoji) => {
                onReact(entry, emoji)
                setPickerOpen(false)
              }}
            />
          ) : null}
        </div>
      </div>
    </>
  )
}
