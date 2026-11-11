import { useCallback, useRef, useState, type RefObject } from 'react'
import {
  CHECKING_CONNECTIONS,
  COMPUTER_ASK,
  COMPUTER_INSTRUCTION,
  CONNECTED_SUMMARY,
  CONTEXT_MESSAGE,
  DONE_MESSAGE,
  DRAFTS_MESSAGE,
  EMAIL,
  END_SCREEN,
  GREETING,
  INITIAL_SCREEN,
  PASSWORD_LENGTH,
  ROUTINE,
  SEND_MESSAGE,
  USER_REQUEST,
} from '../data/copy'
import { ACTIVE_AGENT } from '../data/agents'
import { FINAL_TRANSCRIPT } from '../data/transcript'
import { formatTime } from '../lib/format-time'
import { uniqueId } from '../lib/ids'
import { messageDelay } from '../lib/message-delay'
import { stripMarkdown } from '../lib/rich-text'
import { wait } from '../lib/dom'
import type {
  ComputerStatus,
  PendingBeat,
  ScreenOverlayState,
  ScriptedScreen,
  TranscriptEntry,
} from '../types'
import { useCursor } from './useCursor'

export function useDemoSequence(rootRef: RefObject<HTMLElement | null>) {
  const {
    cursor: cursorState,
    ripples,
    reset: resetCursor,
    showAt,
    moveToTarget,
    click,
    hide: hideCursor,
    waitForTarget,
  } = useCursor(rootRef)
  const [agentName, setAgentName] = useState('New agent')
  const [agentPreview, setAgentPreview] = useState('Typing…')
  const [agentTime, setAgentTime] = useState('3:26 AM')
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([])
  const [pending, setPending] = useState<PendingBeat | null>({ label: null, showLabel: false })
  const [screen, setScreen] = useState<ScriptedScreen>(INITIAL_SCREEN)
  const [overlay, setOverlay] = useState<ScreenOverlayState | null>(null)
  const [cardStatus, setCardStatus] = useState<ComputerStatus>('action-needed')
  const [sidePaneOpen, setSidePaneOpen] = useState(false)
  const runIdRef = useRef(0)
  const startedRef = useRef(false)

  const applyEndState = useCallback(() => {
    runIdRef.current += 1
    startedRef.current = true
    setAgentName('Sales Outbound')
    setAgentPreview(DONE_MESSAGE)
    setAgentTime(formatTime(Date.now()))
    setTranscript(FINAL_TRANSCRIPT)
    setPending(null)
    setScreen(END_SCREEN)
    setCardStatus('done')
    setOverlay(null)
    setSidePaneOpen(false)
    resetCursor()
  }, [resetCursor])

  const finishTakeOver = useCallback(() => {
    setCardStatus('working')
    setScreen((previous) => ({ ...previous, isWorking: true }))
    window.setTimeout(() => {
      setOverlay(null)
      window.setTimeout(() => setCardStatus('done'), 800)
    }, 250)
  }, [])

  const start = useCallback(async () => {
    if (startedRef.current) return
    startedRef.current = true
    resetCursor()

    const id = ++runIdRef.current
    const alive = () => runIdRef.current === id
    const add = (entry: TranscriptEntry) => {
      if (alive()) setTranscript((previous) => [...previous, entry])
    }
    const preview = (text: string) => {
      if (alive()) setAgentPreview(stripMarkdown(text))
    }
    const stamp = () => Date.now()
    const showPending = (label: string | null, totalMs: number) => {
      if (!alive()) return
      setPending({ label, showLabel: false })
      if (totalMs > 0) {
        window.setTimeout(() => {
          if (alive()) setPending((previous) => (previous ? { ...previous, showLabel: true } : previous))
        }, Math.max(0, totalMs - 900))
      }
    }
    const agentMessage = async (content: string, label: string | null = null) => {
      const totalMs = messageDelay(content)
      showPending(label, totalMs)
      await wait(totalMs)
      if (!alive()) return
      add({
        kind: 'agent-message',
        id: uniqueId('agent'),
        content,
        timestampMs: stamp(),
      })
      setPending(null)
      setAgentTime(formatTime(stamp()))
      preview(content)
    }
    const userMessage = (content: string) => {
      add({
        kind: 'user-message',
        id: uniqueId('user'),
        content,
        timestampMs: stamp(),
      })
      setAgentTime(formatTime(stamp()))
      preview(content)
    }

    setPending({ label: null, showLabel: false })
    await wait(250)
    if (!alive()) return
    await agentMessage(GREETING, 'Spawning')
    if (!alive()) return
    await wait(900)
    if (!alive()) return
    userMessage(USER_REQUEST)
    await wait(500)
    if (!alive()) return
    setAgentName('Sales Outbound')
    add({
      kind: 'system',
      id: uniqueId('rename'),
      event: { type: 'renamed', name: 'Sales Outbound' },
      timestampMs: stamp(),
    })
    await wait(300)
    if (!alive()) return
    await agentMessage(CHECKING_CONNECTIONS, 'Checking connections')
    if (!alive()) return
    await wait(350)
    if (!alive()) return
    setCardStatus('action-needed')
    setScreen(INITIAL_SCREEN)
    add({
      kind: 'computer',
      id: 'computer-1',
      instruction: COMPUTER_INSTRUCTION,
      ask: COMPUTER_ASK,
      status: 'action-needed',
      screenKind: 'crm-portal',
      timestampMs: stamp(),
    })
    preview(CHECKING_CONNECTIONS)

    try {
      await wait(1400)
      if (!alive()) return
      const takeOver = await waitForTarget('computer-take-over')
      const root = rootRef.current
      if (root) {
        const rootRect = root.getBoundingClientRect()
        const rect = takeOver.getBoundingClientRect()
        await showAt(
          rect.left - rootRect.left + rect.width * 0.5 + 56,
          rect.top - rootRect.top + rect.height * 0.55 + 44,
        )
      }
      await moveToTarget(takeOver)
      await click(() => setCardStatus('handed-over'))
      await wait(220)
      if (!alive()) return
      setOverlay({ mode: 'takeover', origin: 'entry', instruction: COMPUTER_ASK })
      await wait(650)
      if (!alive()) return
      const emailField = await waitForTarget('portal-email')
      await moveToTarget(emailField, 0.25)
      await click(() => setScreen({ ...INITIAL_SCREEN, emailChars: 5, focus: 'email' }))
      for (const count of [10, EMAIL.length]) {
        if (!alive()) return
        setScreen({ ...INITIAL_SCREEN, emailChars: count, focus: 'email' })
        await wait(70)
      }
      if (!alive()) return
      setScreen({
        ...INITIAL_SCREEN,
        emailChars: EMAIL.length,
        passwordChars: PASSWORD_LENGTH,
        focus: 'password',
      })
      await wait(120)
      const submit = await waitForTarget('portal-submit')
      await moveToTarget(submit)
      await click(() => setScreen({ ...END_SCREEN, view: 'portal', isWorking: false }))
      await wait(850)
      if (!alive()) return
      const done = await waitForTarget('screen-done')
      await moveToTarget(done)
      await click(() => finishTakeOver())
      await wait(400)
      if (!alive()) return
      hideCursor()
      await wait(1000)
      if (!alive()) return
    } catch {
      if (!alive()) return
      setOverlay(null)
    }

    await wait(1500)
    if (!alive()) return
    await agentMessage(CONNECTED_SUMMARY, 'Wrapping the run')
    if (!alive()) return
    await wait(800)
    if (!alive()) return
    setCardStatus('done')
    await wait(700)
    if (!alive()) return
    await wait(900)
    if (!alive()) return
    add({
      kind: 'system',
      id: uniqueId('context'),
      event: {
        type: 'received-context',
        sources: [{ name: 'Account Manager' }, { name: 'Chief' }],
      },
      timestampMs: stamp(),
    })
    setAgentPreview('Messages from Account Manager and Chief')
    setAgentTime(formatTime(stamp()))
    await wait(600)
    if (!alive()) return
    await agentMessage(CONTEXT_MESSAGE, 'Receiving context')
    if (!alive()) return
    await wait(900)
    if (!alive()) return
    await agentMessage(DRAFTS_MESSAGE, 'Drafting')
    if (!alive()) return
    await wait(1400)
    if (!alive()) return
    userMessage(SEND_MESSAGE)
    await wait(700)
    if (!alive()) return
    setTranscript((previous) => {
      const next = [...previous]
      for (let index = next.length - 1; index >= 0; index -= 1) {
        const entry = next[index]
        if (entry.kind === 'user-message') {
          next[index] = {
            ...entry,
            reactions: entry.reactions?.includes('👍')
              ? entry.reactions
              : [...(entry.reactions ?? []), '👍'],
          }
          break
        }
      }
      return next
    })
    await wait(700)
    if (!alive()) return
    add({
      kind: 'system',
      id: uniqueId('routine'),
      event: { type: 'created-routine', ...ROUTINE },
      timestampMs: stamp(),
    })
    setAgentPreview(`Created routine ${ROUTINE.name}`)
    await wait(300)
    if (!alive()) return
    await agentMessage(DONE_MESSAGE)
    if (!alive()) return
    setPending(null)
    setCardStatus('done')
  }, [
    click,
    finishTakeOver,
    hideCursor,
    moveToTarget,
    resetCursor,
    rootRef,
    showAt,
    waitForTarget,
  ])

  const takeOver = useCallback(() => {
    setCardStatus('handed-over')
    setOverlay({ mode: 'takeover', origin: 'entry', instruction: COMPUTER_ASK })
  }, [])

  const openScreen = useCallback((origin: 'entry' | 'pane' = 'entry') => {
    setOverlay({ mode: 'lightbox', origin })
  }, [])

  const closeScreen = useCallback(() => setOverlay(null), [])
  const toggleComputer = useCallback(() => setSidePaneOpen((previous) => !previous), [])
  const closeComputer = useCallback(() => setSidePaneOpen(false), [])
  const cancel = useCallback(() => {
    runIdRef.current += 1
    startedRef.current = false
  }, [])

  return {
    agentName,
    agentPreview,
    agentTime,
    activeAgent: ACTIVE_AGENT,
    transcript,
    pending,
    screen,
    overlay,
    cardStatus,
    sidePaneOpen,
    cursor: cursorState,
    ripples,
    start,
    applyEndState,
    finishTakeOver,
    takeOver,
    openScreen,
    closeScreen,
    toggleComputer,
    closeComputer,
    cancel,
  }
}
