import { useEffect, useRef, useState } from 'react'
import { CloseIcon } from '../components/icons'
import { tickets, type OpenLinkDemoScenario } from './scenarios'

export type DemoStep = 'ready' | 'running' | 'action' | 'control' | 'done'
export type Schedule = 'Every Monday' | 'Every Friday'

type DemoInspectorProps = {
  scenario: OpenLinkDemoScenario
  step: DemoStep
  schedule: Schedule
  approved: boolean | null
  open: boolean
  onClose: () => void
  onTakeOver: () => void
  onResume: () => void
}

export function DemoInspector({ scenario, step, schedule, approved, open, onClose, onTakeOver, onResume }: DemoInspectorProps) {
  const [ticketId, setTicketId] = useState(tickets[0]!.id)
  const resume = useRef<HTMLButtonElement>(null)
  const selected = tickets.find(({ id }) => id === ticketId)!
  const title = { computer: 'Bot computer', team: 'Launch handoff', routine: 'Schedule preview' }[scenario]

  useEffect(() => {
    if (open && step === 'control') resume.current?.focus({ preventScroll: true })
  }, [open, step])

  return (
    <aside aria-label={title} className="oldemo-inspector">
      <header className="oldemo-pane-heading">
        <strong>{title}</strong>
        <button aria-label={`Close ${title.toLowerCase()}`} className="oldemo-icon" onClick={onClose} type="button"><CloseIcon /></button>
      </header>
      <div className="oldemo-inspector-content">
        {scenario === 'computer' ? (
          <div className="oldemo-browser">
            <div className="oldemo-browser-bar"><span aria-hidden="true" /><span>support.harbor.example</span></div>
            {step === 'control' ? (
              <div className="oldemo-document">
                <span className="oldemo-document-label">You’re in control</span>
                <h3>Allow access to the sample queue?</h3>
                <p>Grant Support Bot read-only access for this run.</p>
                <button className="oldemo-primary" onClick={onResume} ref={resume} type="button">Allow access and resume</button>
              </div>
            ) : (
              <div className="oldemo-document">
                <span className="oldemo-document-label">Harbor Support</span>
                <h3>Open tickets</h3>
                <div className="oldemo-tickets">
                  {tickets.map((ticket) => (
                    <button aria-pressed={ticket.id === ticketId} key={ticket.id} onClick={() => setTicketId(ticket.id)} type="button">
                      <span><small>{ticket.id}</small>{ticket.title}</span>
                      <small data-priority={ticket.priority}>{ticket.priority}</small>
                    </button>
                  ))}
                </div>
                <p>{selected.detail}</p>
                {step === 'action' ? <button className="oldemo-primary" onClick={onTakeOver} type="button">Take over</button> : null}
              </div>
            )}
          </div>
        ) : scenario === 'team' ? (
          <div className="oldemo-document oldemo-document-standalone">
            <span className="oldemo-document-label">{approved === true ? 'Approved' : approved === false ? 'Draft retained' : 'Draft'}</span>
            <h3>Billing dashboard rollout</h3>
            <dl>
              <div><dt>Release</dt><dd>Account totals and invoice history in one view</dd></div>
              <div><dt>QA</dt><dd>Core flows passed. Large CSV exports need a follow-up.</dd></div>
              <div><dt>Owner</dt><dd>Billing team</dd></div>
            </dl>
          </div>
        ) : (
          <div className="oldemo-document oldemo-document-standalone">
            <span className="oldemo-document-label">{step === 'done' ? 'Scheduled' : 'Proposed schedule'}</span>
            <h3>Open issue digest</h3>
            <dl>
              <div><dt>When</dt><dd>{schedule} at 9:00 AM</dd></div>
              <div><dt>Source</dt><dd>Open product issues</dd></div>
              <div><dt>Deliver to</dt><dd>Project Bot chat</dd></div>
            </dl>
          </div>
        )}
      </div>
    </aside>
  )
}
