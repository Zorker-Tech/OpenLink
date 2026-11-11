import type { ComputerStatus } from '../types'
import { SpinnerIcon } from './icons'

export function ComputerBadge({ status }: { status: ComputerStatus }) {
  if (status === 'action-needed') {
    return (
      <span className="zbd-card-badge" data-tone="warning">
        <SpinnerIcon size={12} />
        Action needed
      </span>
    )
  }

  if (status === 'handed-over') {
    return (
      <span className="zbd-card-badge" data-tone="warning">
        <span className="zbd-card-badge-dot" />
        You’re in control
      </span>
    )
  }

  if (status === 'working') {
    return (
      <span className="zbd-card-badge" data-tone="accent">
        <SpinnerIcon size={12} />
        Working
      </span>
    )
  }

  return (
    <span className="zbd-card-badge" data-tone="success">
      <span className="zbd-card-badge-dot" />
      Done
    </span>
  )
}
