import type { TranscriptEntry } from '../types'
import { ClockIcon } from './icons'
import { SystemAgentPill } from './SystemAgentPill'

export type SystemEntryProps = {
  entry: Extract<TranscriptEntry, { kind: 'system' }>
  assetBase: string
}

export function SystemEntry({ entry, assetBase }: SystemEntryProps) {
  if (entry.event.type === 'renamed') {
    return <div className="zbd-system-line">Renamed to {entry.event.name}</div>
  }

  if (entry.event.type === 'received-context') {
    return (
      <div className="zbd-system-line">
        <span>Messages from</span>
        {entry.event.sources.map((source, index) => (
          <span className="zbd-system-inline" key={source.name}>
            {index > 0 ? <span>and</span> : null}
            <SystemAgentPill assetBase={assetBase} name={source.name} />
          </span>
        ))}
      </div>
    )
  }

  if (entry.event.type === 'created-routine') {
    return (
      <div className="zbd-system-line">
        <span>Created routine</span>
        <span className="zbd-system-routine">
          <ClockIcon size={15} />
          <span>{entry.event.name}</span>
        </span>
      </div>
    )
  }

  return <div className="zbd-system-line">Memory updated</div>
}
