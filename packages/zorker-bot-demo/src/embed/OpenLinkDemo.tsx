'use client'

import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react'
import { AppCommandPalette } from '../app/AppCommandPalette'
import { AppComposer } from '../app/AppComposer'
import { AppTranscript } from '../app/AppTranscript'
import { OpenLinkAppShell, OpenLinkNavigationRail } from '../app/OpenLinkAppShell'
import { ClockIcon, MonitorIcon, SearchIcon } from '../components/icons'
import { END_SCREEN } from '../data/copy'
import type { TranscriptEntry } from '../types'
import { DemoInspector, type DemoStep, type Schedule } from './DemoInspector'
import { activity, confirmation, message, scenarioIds, scenarios, scheduled, teamMembers, type OpenLinkDemoScenario } from './scenarios'

export type OpenLinkDemoProps = {
  initialScenario?: OpenLinkDemoScenario
  theme?: 'light' | 'dark' | 'auto'
  className?: string
}

const paletteSessions = scenarioIds.map((id) => ({ session: scenarios[id].session, name: scenarios[id].session.name }))
const scenarioIcons = { computer: MonitorIcon, team: TeamIcon, routine: ClockIcon }
const stepLabels: Record<DemoStep, string> = {
  ready: 'Ready',
  running: 'Working',
  action: 'Waiting for you',
  control: 'You’re in control',
  done: 'Complete',
}

function TeamIcon({ size = 16 }: { size?: number }) {
  return (
    <svg aria-hidden="true" fill="none" height={size} stroke="currentColor" strokeLinecap="round" strokeWidth="1.3" viewBox="0 0 16 16" width={size}>
      <circle cx="6.1" cy="5.1" r="2.1" />
      <path d="M2 13v-1.4a3 3 0 0 1 3-3h2.2a3 3 0 0 1 3 3V13M10.1 3.2a2.1 2.1 0 0 1 0 4.1m1.1 1.5a3 3 0 0 1 2.8 3V13" />
    </svg>
  )
}

function BotMark({ scenario }: { scenario: OpenLinkDemoScenario }) {
  const { name, ink } = scenarios[scenario].session
  return <span aria-hidden="true" className="oldemo-avatar" style={{ backgroundColor: ink }}>{name[0]}</span>
}

function workHandoff(scenario: OpenLinkDemoScenario): TranscriptEntry[] {
  switch (scenario) {
    case 'computer':
      return [
        activity('open-queue', 'Opened the support queue', 'Harbor Support'),
        confirmation('takeover', 'Workspace access required', 'Take over the computer to grant read-only access to the sample queue.'),
      ]
    case 'team':
      return [
        message('agent-message', 'release', 'The release notes are ready. QA Bot, could you check the rollout checklist?', 'Release Bot'),
        message('agent-message', 'qa', 'The core flows passed. I’ve added a follow-up for large CSV exports.', 'QA Bot'),
        confirmation('approve', 'Review the launch handoff', 'Approve the draft or keep it for further review.'),
      ]
    case 'routine':
      return [
        activity('read-issues', 'Reviewed open product issues', '2 unassigned · 3 in progress'),
        confirmation('schedule', 'Choose a schedule', 'Run a weekly digest at 9:00 AM.'),
      ]
  }
}

function answered(entries: TranscriptEntry[]) {
  return entries.map((entry): TranscriptEntry => entry.kind === 'confirmation'
    ? { ...entry, confirmation: { ...entry.confirmation, status: 'answered' } }
    : entry)
}

export function OpenLinkDemo({ className, initialScenario = 'computer', theme = 'auto' }: OpenLinkDemoProps) {
  const [scenario, setScenario] = useState<OpenLinkDemoScenario>(initialScenario)
  const [run, setRun] = useState(0)
  const choiceLabel = useId()

  return (
    <div className={['oldemo', className].filter(Boolean).join(' ')} data-oldemo-theme={theme}>
      <div aria-labelledby={choiceLabel} className="oldemo-scenarios" role="group">
        <span className="oldemo-sr" id={choiceLabel}>Choose a demo scenario</span>
        {scenarioIds.map((id) => {
          const Icon = scenarioIcons[id]
          return (
            <button aria-pressed={scenario === id} key={id} onClick={() => setScenario(id)} type="button">
              <Icon />{scenarios[id].label}
            </button>
          )
        })}
      </div>
      <DemoWorkspace
        key={`${scenario}-${run}`}
        onReset={() => setRun((value) => value + 1)}
        onSelect={setScenario}
        scenario={scenario}
      />
      <p className="oldemo-caption">{scenarios[scenario].description} <span>Simulated workspace</span></p>
    </div>
  )
}

function DemoWorkspace({ onReset, onSelect, scenario }: {
  scenario: OpenLinkDemoScenario
  onReset: () => void
  onSelect: (scenario: OpenLinkDemoScenario) => void
}) {
  const { session, prompt, followUp } = scenarios[scenario]
  const root = useRef<HTMLDivElement>(null)
  const transcript = useRef<HTMLDivElement>(null)
  const searchTrigger = useRef<HTMLButtonElement>(null)
  const inspectorTrigger = useRef<HTMLButtonElement>(null)
  const promptCounter = useRef(0)
  const [entries, setEntries] = useState(session.transcript)
  const [step, setStep] = useState<DemoStep>('ready')
  const [draft, setDraft] = useState('')
  const [schedule, setSchedule] = useState<Schedule>('Every Monday')
  const [approved, setApproved] = useState<boolean | null>(null)
  const [compact, setCompact] = useState(false)
  const [panel, setPanel] = useState<boolean | null>(null)
  const [sidebar, setSidebar] = useState<boolean | null>(null)
  const [palette, setPalette] = useState(false)
  const [query, setQuery] = useState('')
  const sidebarId = useId()
  const panelId = useId()
  const paneOpen = panel ?? !compact
  const sidebarOpen = sidebar ?? !compact
  const waiting = step === 'action' || step === 'control'

  useEffect(() => {
    const element = root.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => { if (entry) setCompact(entry.contentRect.width <= 760) })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (step !== 'running') return
    const timeout = window.setTimeout(() => {
      setEntries((current) => [...current, ...workHandoff(scenario)])
      setStep('action')
    }, window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 750)
    return () => window.clearTimeout(timeout)
  }, [scenario, step])

  useLayoutEffect(() => {
    const element = transcript.current
    if (element) element.scrollTop = element.scrollHeight
  }, [entries, step])

  function start(text: string) {
    setDraft('')
    setEntries((current) => [...current, message('user-message', 'prompt', text)])
    setStep('running')
  }

  function send() {
    const text = draft.trim()
    if (!text) return
    if (step === 'ready') {
      start(text)
      return
    }
    if (step !== 'done') return
    promptCounter.current += 1
    const id = promptCounter.current
    setDraft('')
    setEntries((current) => [
      ...current,
      message('user-message', `followup-${id}`, text),
      message('agent-message', `reply-${id}`, followUp, scenario === 'team' ? 'Release Bot' : undefined),
    ])
  }

  function finish(result: TranscriptEntry[]) {
    setEntries((current) => [...answered(current), ...result])
    setStep('done')
  }

  function takeOver() {
    setStep('control')
    setPanel(true)
  }

  function resume() {
    finish([
      activity('read-queue', 'Read 3 tickets', '2 need replies today'),
      message('agent-message', 'result', '**Reply today**\n• OL-104 — Billing export stops on large reports.\n• OL-108 — Sign-in loops after switching workspaces.\n\nOL-112 can wait until tomorrow.'),
    ])
    if (compact) closeInspector()
  }

  function decide(approve: boolean) {
    setApproved(approve)
    finish([message('agent-message', 'decision', approve
      ? 'Approved. The release notes, QA exceptions and owner are ready to share with Billing.'
      : 'I’ve kept the handoff in drafts with QA’s notes attached.', 'Release Bot')])
  }

  function saveSchedule() {
    finish([
      scheduled(`${schedule} at 9:00 AM`),
      message('agent-message', 'result', `Scheduled for **${schedule.toLowerCase()} at 9:00 AM**. I’ll post the digest in this chat.`),
    ])
  }

  function closeInspector() {
    setPanel(false)
    inspectorTrigger.current?.focus({ preventScroll: true })
  }

  function closePalette() {
    setPalette(false)
    setQuery('')
    searchTrigger.current?.focus({ preventScroll: true })
  }

  function pick(id: OpenLinkDemoScenario) {
    if (id !== scenario) onSelect(id)
    else {
      if (palette) closePalette()
      if (compact) setSidebar(false)
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault()
      if (!palette) setPalette(true)
    }
    if (event.key === 'Escape' && paneOpen && compact && !palette) closeInspector()
  }

  return (
    <OpenLinkAppShell
      aria-label="OpenLink Bot workspace demo"
      className="oldemo-workspace zbd-root"
      data-pane-default={panel === null}
      data-sidebar-default={sidebar === null}
      navigation={
        <>
          <OpenLinkNavigationRail
            aria-label="Demo workspace navigation"
            className="oldemo-rail"
            footer={<span aria-label="Demo account" className="oldemo-account" role="img">OL</span>}
          >
            <button aria-controls={sidebarId} aria-expanded={sidebarOpen} aria-label="Bot conversations" className="oldemo-icon" onClick={() => setSidebar(!sidebarOpen)} title="Bot conversations" type="button">
              <TeamIcon size={18} />
            </button>
            <button aria-label="Find a Bot" className="oldemo-icon" onClick={() => setPalette(true)} ref={searchTrigger} title="Find a Bot" type="button">
              <SearchIcon size={18} />
            </button>
          </OpenLinkNavigationRail>
          <aside aria-label="Bot conversations" className="oldemo-sidebar" hidden={!sidebarOpen} id={sidebarId}>
            <strong>Conversations</strong>
            {scenarioIds.map((id) => (
              <button aria-current={scenario === id ? 'true' : undefined} key={id} onClick={() => pick(id)} type="button">
                <BotMark scenario={id} />
                <span>{scenarios[id].session.name}<small>{scenarios[id].label}</small></span>
              </button>
            ))}
          </aside>
        </>
      }
      onKeyDown={onKeyDown}
      overlay={palette ? (
        <AppCommandPalette
          assetBase=""
          onClose={closePalette}
          onQueryChange={setQuery}
          onSelect={(id) => pick(id as OpenLinkDemoScenario)}
          query={query}
          scopeKeyboard
          sessions={paletteSessions}
        />
      ) : null}
      ref={root}
      role="region"
    >
      <section aria-label={session.name} className="oldemo-conversation zbd-chat zbd-app-chat">
        <header className="oldemo-chat-heading">
          <BotMark scenario={scenario} />
          <div><strong>{session.name}</strong><span aria-live="polite" className="oldemo-status" data-step={step}>{stepLabels[step]}</span></div>
          <button
            aria-controls={panelId}
            aria-expanded={paneOpen}
            aria-label={scenario === 'computer' ? 'Bot computer' : 'Task details'}
            className="oldemo-icon"
            onClick={() => setPanel(!paneOpen)}
            ref={inspectorTrigger}
            type="button"
          >
            <MonitorIcon size={17} />
          </button>
        </header>
        <AppTranscript
          assetBase=""
          cardStatus="done"
          displayName={session.name}
          entries={entries}
          locale="en-US"
          onFinishComputer={resume}
          onOpenComputer={() => setPanel(true)}
          onSuggestion={setDraft}
          onTakeOver={takeOver}
          pending={step === 'running' ? { label: 'Checking the workspace', showLabel: true } : null}
          screen={END_SCREEN}
          session={session}
          transcriptRef={transcript}
        />
        {step === 'ready' || step === 'done' || waiting ? (
          <div className="oldemo-actions">
            {step === 'ready' ? <button className="oldemo-primary" onClick={() => start(prompt)} type="button"><span aria-hidden="true">▶</span> Play demo</button> : null}
            {step === 'done' ? <button className="oldemo-secondary" onClick={onReset} type="button">Reset demo</button> : null}
            {step === 'action' && scenario === 'computer' ? <button className="oldemo-primary" onClick={takeOver} type="button">Take over computer</button> : null}
            {step === 'control' ? <button className="oldemo-secondary" onClick={() => setPanel(true)} type="button">Show computer</button> : null}
            {step === 'action' && scenario === 'team' ? (
              <>
                <button className="oldemo-primary" onClick={() => decide(true)} type="button">Approve handoff</button>
                <button className="oldemo-secondary" onClick={() => decide(false)} type="button">Keep as draft</button>
              </>
            ) : null}
            {step === 'action' && scenario === 'routine' ? (
              <>
                <select aria-label="Schedule day" onChange={(event) => setSchedule(event.target.value as Schedule)} value={schedule}>
                  <option>Every Monday</option>
                  <option>Every Friday</option>
                </select>
                <button className="oldemo-primary" onClick={saveSchedule} type="button">Save routine</button>
              </>
            ) : null}
          </div>
        ) : null}
        <AppComposer
          disabled={step === 'running' || waiting}
          displayName={session.name}
          groupMembers={scenario === 'team' ? teamMembers : undefined}
          onChange={setDraft}
          onSend={send}
          showRoutine={false}
          showVoice={false}
          value={draft}
        />
      </section>
      <div className="oldemo-pane" hidden={!paneOpen} id={panelId}>
        <DemoInspector
          approved={approved}
          onClose={closeInspector}
          onResume={resume}
          onTakeOver={takeOver}
          open={paneOpen}
          scenario={scenario}
          schedule={schedule}
          step={step}
        />
      </div>
    </OpenLinkAppShell>
  )
}
