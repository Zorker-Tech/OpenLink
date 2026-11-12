import type { TranscriptEntry } from '../types'

export type ActivityCardProps = {
  entry: Extract<TranscriptEntry, { kind: 'activity' }>
}

function statusLabel(status: Extract<TranscriptEntry, { kind: 'activity' }>['activity']['status']) {
  if (status === 'failed') return 'Failed'
  if (status === 'done') return 'Done'
  return 'Working'
}

export function ActivityCard({ entry }: ActivityCardProps) {
  const { activity } = entry
  return (
    <div className="zbd-activity-card" data-status={activity.status}>
      <span aria-hidden="true" className="zbd-activity-dot" />
      <span className="zbd-activity-copy">
        <span className="zbd-activity-label">{activity.label}</span>
        {activity.detail ? <span className="zbd-activity-detail">{activity.detail}</span> : null}
      </span>
      <span className="zbd-activity-status">{statusLabel(activity.status)}</span>
    </div>
  )
}
