import type { CursorState } from '../types'
import { CursorArrow } from './icons'

export type DemoCursorProps = {
  cursor: CursorState
  ripples: { id: number; x: number; y: number }[]
}

export function DemoCursor({ cursor, ripples }: DemoCursorProps) {
  return (
    <>
      {ripples.map((ripple) => (
        <span className="zbd-cursor-ripple" key={ripple.id} style={{ left: ripple.x, top: ripple.y }} />
      ))}
      <div
        className="zbd-cursor"
        style={{
          opacity: cursor.visible ? 1 : 0,
          transform: `translate3d(${cursor.x}px, ${cursor.y}px, 0)`,
          transition: `transform ${cursor.duration}ms cubic-bezier(.3,.1,.25,1), opacity .25s ease`,
        }}
      >
        <CursorArrow />
        <span className="zbd-cursor-label">You</span>
      </div>
    </>
  )
}
