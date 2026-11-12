import type { TranscriptEntry } from '../types'

export type ConfirmationCardProps = {
  entry: Extract<TranscriptEntry, { kind: 'confirmation' }>
}

/**
 * A question the Bot needs answered. It uses the same compact card shell as an
 * activity row so the timeline keeps one rhythm; the answer control stays in
 * the composer dock, where it already lives.
 */
export function ConfirmationCard({ entry }: ConfirmationCardProps) {
  const { confirmation } = entry
  const pending = confirmation.status === 'pending'
  return (
    <div className="zbd-activity-card" data-status={pending ? 'running' : 'done'}>
      <span aria-hidden="true" className="zbd-activity-dot" />
      <span className="zbd-activity-copy">
        <span className="zbd-activity-label">{confirmation.title}</span>
        {confirmation.message ? (
          <span className="zbd-activity-detail">{confirmation.message}</span>
        ) : null}
      </span>
      <span className="zbd-activity-status">
        {pending ? 'Answer needed' : 'Answered'}
      </span>
    </div>
  )
}
