'use client'

import { ContextMenu } from '@base-ui/react/context-menu'
import { QUICK_REACTIONS } from '@zorker/bot-demo/components/EmojiPicker'
import type { MessageMenuActions } from '@zorker/bot-demo/components/MessageBubble'
import { Clipboard, Copy, Reply, SmilePlus } from 'lucide-react'
import type { ReactElement } from 'react'

import { useOpenLinkTheme } from '@/components/ui/theme-scope'

export function BotMessageContextMenu({ bubble, actions, requestId }: {
  bubble: ReactElement
  actions: MessageMenuActions
  requestId?: string
}) {
  const theme = useOpenLinkTheme()
  const { reply } = actions

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger
        onContextMenuCapture={(event) => {
          const selection = window.getSelection()
          if (selection?.anchorNode && event.currentTarget.contains(selection.anchorNode)) selection.removeAllRanges()
        }}
        onMouseDown={(event) => {
          if (event.button === 2) event.preventDefault()
        }}
        render={bubble}
        tabIndex={0}
      />
      <ContextMenu.Portal>
        <ContextMenu.Positioner className="z-[80] outline-none">
          <ContextMenu.Popup className="bot-message-context-menu" data-theme={theme ? `bot-${theme}` : undefined}>
            {actions.react ? (
              <ContextMenu.Group aria-label="Quick reactions" className="bot-message-context-reactions">
                {QUICK_REACTIONS.map((emoji) => (
                  <ContextMenu.Item aria-label={`React with ${emoji}`} key={emoji} onClick={() => actions.react?.(emoji)}>
                    {emoji}
                  </ContextMenu.Item>
                ))}
                <ContextMenu.Item aria-label="More reactions" onClick={() => requestAnimationFrame(actions.openEmojiPicker)}>
                  <SmilePlus size={16} />
                </ContextMenu.Item>
              </ContextMenu.Group>
            ) : null}
            {reply ? (
              <ContextMenu.Item className="bot-message-context-item" onClick={() => requestAnimationFrame(reply)}>
                <Reply size={15} /> Reply
              </ContextMenu.Item>
            ) : null}
            <ContextMenu.Item className="bot-message-context-item" onClick={() => actions.copy()}>
              <Copy size={15} /> Copy message
            </ContextMenu.Item>
            {requestId ? (
              <ContextMenu.Item className="bot-message-context-item" onClick={() => actions.copy(requestId)}>
                <Clipboard size={15} /> Copy request ID
              </ContextMenu.Item>
            ) : null}
          </ContextMenu.Popup>
        </ContextMenu.Positioner>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  )
}
