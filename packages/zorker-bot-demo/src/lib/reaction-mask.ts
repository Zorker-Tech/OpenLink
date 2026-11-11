import type { CSSProperties } from 'react'

export function reactionMask(count: number, side: 'user' | 'agent'): CSSProperties {
  const masks = Array.from({ length: count }, (_, index) => {
    const offset = 20 + 22 * index
    const at = side === 'user' ? `calc(100% - ${offset}px)` : `${offset}px`
    return `radial-gradient(circle at ${at} calc(100% + 4px), transparent 11.5px, #000 12px)`
  }).join(', ')

  return {
    maskImage: masks,
    WebkitMaskImage: masks,
    maskComposite: 'intersect',
    WebkitMaskComposite: 'source-in',
  }
}
