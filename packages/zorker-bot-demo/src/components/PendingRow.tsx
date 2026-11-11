import type { PendingBeat } from '../types'

export type PendingRowProps = {
  pending: PendingBeat
  assetBase: string
}

export function PendingRow({ pending, assetBase }: PendingRowProps) {
  const label = pending.label && pending.showLabel ? pending.label : 'Thinking'

  return (
    <div className="zbd-pending">
      <span className="zbd-pending-avatar">
        <img alt="" draggable={false} src={`${assetBase}/avatars/header.svg`} />
      </span>
      <span className="zbd-pending-label">{label}</span>
    </div>
  )
}
