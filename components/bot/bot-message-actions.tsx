'use client'

import { Menu } from '@base-ui/react/menu'
import type { MessageToolbarActions } from '@zorker/bot-demo/components/MessageBubble'
import { Check, Copy, Ellipsis, Reply, SmilePlus } from 'lucide-react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { useOpenLinkTheme } from '@/components/ui/theme-scope'

const CONTROL_SIZE = 26
const GAP = 6
const BUTTON_GAP = 2

type Placement = { mode: 'inline' | 'menu'; gap: number; top: number; available: number }

export function BotMessageActions({ actions }: { actions: MessageToolbarActions }) {
  const { entry, copied, pickerOpen, react, reply, copy, toggleEmojiPicker } = actions
  const isUser = entry.kind === 'user-message'
  const theme = useOpenLinkTheme()
  const reduceMotion = useReducedMotion()
  const toolbarRef = useRef<HTMLDivElement>(null)
  const moreRef = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [placement, setPlacement] = useState<Placement>({ mode: 'menu', gap: GAP, top: 0, available: CONTROL_SIZE })
  const items = [
    ...(react ? [{
      id: 'reaction',
      label: 'Add a reaction',
      icon: SmilePlus,
      select: (anchor: HTMLElement) => toggleEmojiPicker(anchor),
    }] : []),
    ...(reply ? [{ id: 'reply', label: 'Reply', icon: Reply, select: reply }] : []),
    { id: 'copy', label: copied ? 'Copied' : 'Copy message', icon: copied ? Check : Copy, select: () => copy() },
  ]
  const fullWidth = items.length * CONTROL_SIZE + (items.length - 1) * BUTTON_GAP

  useLayoutEffect(() => {
    const wrap = toolbarRef.current?.closest('.zbd-bubble-wrap')
    const row = wrap?.closest('.zbd-message-row')
    const bubble = wrap?.querySelector('.zbd-bubble')
    if (!wrap || !row || !bubble) return
    const reactions = wrap.querySelector('.zbd-reactions')
    const measure = () => {
      const outer = row.getBoundingClientRect()
      const box = bubble.getBoundingClientRect()
      if (!outer.width || !box.width) return
      const toRight = isUser === (getComputedStyle(row).direction === 'rtl')
      const space = toRight ? outer.right - box.right : box.left - outer.left
      const chip = reactions?.getBoundingClientRect()
      const top = (box.height - CONTROL_SIZE) / 2
      const overlapsControlLine = chip && chip.width && chip.top < box.top + top + CONTROL_SIZE && chip.bottom > box.top + top
      const chipExtension = overlapsControlLine ? (toRight ? chip.right - box.right : box.left - chip.left) : 0
      const gap = Math.max(GAP, chipExtension + GAP)
      const available = Math.floor(space - gap)
      const mode = available >= fullWidth ? 'inline' : 'menu'
      setPlacement((current) => current.mode === mode && current.gap === gap && current.top === top && current.available === available
        ? current : { mode, gap, top, available })
      if (mode === 'inline') setOpen(false)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(row)
    observer.observe(bubble)
    if (reactions) observer.observe(reactions)
    return () => observer.disconnect()
  }, [entry.reactions, fullWidth, isUser])

  const collapsed = placement.mode !== 'inline'
  const animation = { duration: reduceMotion ? 0 : 0.14, ease: 'easeOut' } as const

  return (
    <div
      className="bot-message-tools"
      data-mode={placement.mode}
      data-open={open || pickerOpen ? '' : undefined}
      data-side={isUser ? 'user' : 'agent'}
      ref={toolbarRef}
      style={{ top: placement.top, '--bot-tool-gap': `${placement.gap}px` } as CSSProperties}
    >
      <motion.div animate={{ width: collapsed ? CONTROL_SIZE : fullWidth }} className="bot-message-tools-track" initial={false} style={{ maxWidth: Math.max(CONTROL_SIZE, placement.available) }} transition={animation}>
        <AnimatePresence initial={false} mode="wait">
          {collapsed ? (
            <motion.div animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.9 }} initial={{ opacity: 0, scale: 0.9 }} key="menu" transition={animation}>
              <Menu.Root onOpenChange={setOpen} open={open}>
                <Menu.Trigger aria-label="Message actions" className="zbd-message-action" ref={moreRef} title="Message actions">
                  <Ellipsis aria-hidden="true" />
                </Menu.Trigger>
                <Menu.Portal keepMounted>
                  <AnimatePresence>
                    {open ? (
                      <Menu.Positioner align="end" className="z-[80] outline-none" key="drawer" sideOffset={6}>
                        <Menu.Popup
                          className="bot-message-context-menu bot-message-action-drawer"
                          data-theme={theme ? `bot-${theme}` : undefined}
                          render={
                            <motion.div
                              animate={{ opacity: 1, scale: 1, y: 0 }}
                              exit={{ opacity: 0, scale: 0.96, y: -4 }}
                              initial={{ opacity: 0, scale: 0.96, y: -4 }}
                              transition={animation}
                            />
                          }
                        >
                          {items.map(({ id, label, icon: Icon, select }) => (
                            <Menu.Item
                              className="bot-message-context-item"
                              key={id}
                              onClick={() => {
                                const anchor = moreRef.current
                                if (anchor) requestAnimationFrame(() => select(anchor))
                              }}
                            >
                              <Icon size={15} /> {label}
                            </Menu.Item>
                          ))}
                        </Menu.Popup>
                      </Menu.Positioner>
                    ) : null}
                  </AnimatePresence>
                </Menu.Portal>
              </Menu.Root>
            </motion.div>
          ) : (
            <motion.div animate={{ opacity: 1 }} className="bot-message-tools-inline" exit={{ opacity: 0 }} initial={{ opacity: 0 }} key="inline" transition={animation}>
              {items.map(({ id, label, icon: Icon, select }) => (
                <button
                  aria-expanded={id === 'reaction' ? pickerOpen : undefined}
                  aria-haspopup={id === 'reaction' ? 'dialog' : undefined}
                  aria-label={label}
                  className="zbd-message-action"
                  key={id}
                  onClick={(event) => select(event.currentTarget)}
                  title={label}
                  type="button"
                >
                  <Icon aria-hidden="true" />
                </button>
              ))}
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    </div>
  )
}
