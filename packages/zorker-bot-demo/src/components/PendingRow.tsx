import type { PendingBeat } from '../types'

export type PendingRowProps = {
  pending: PendingBeat
  assetBase: string
}

const GENERIC_LABELS = new Set(['Working', 'Thinking'])

/**
 * The turn is in flight. Show the same three-dot beat the reference surface
 * uses, inside the transcript, instead of a static "Working" label. A concrete
 * tool/status label is still shown when the host provides one.
 */
export function PendingRow({ pending }: PendingRowProps) {
  const label = pending.label && pending.showLabel && !GENERIC_LABELS.has(pending.label)
    ? pending.label
    : ''

  return (
    <div aria-label={label || 'Typing'} className="zbd-pending" role="status">
      <span aria-hidden="true" className="zbd-typing-dots">
        <span className="zbd-typing-dot" />
        <span className="zbd-typing-dot" />
        <span className="zbd-typing-dot" />
      </span>
      {label ? <span className="zbd-pending-label">{label}</span> : null}
    </div>
  )
}
