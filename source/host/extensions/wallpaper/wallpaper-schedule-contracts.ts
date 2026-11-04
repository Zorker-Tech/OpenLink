import type { Clock } from "../scheduling.ts"

export interface SlateWallpaperTonePlan {
  readonly tone: string
  readonly msUntilNextBoundary: number
}

export interface SlateWallpaperSchedulePorts {
  readonly clock: Clock
  readonly resolvePlan: () => Promise<SlateWallpaperTonePlan | undefined>
  readonly paint: () => Promise<void>
  readonly subscribeToTimeZoneChange: (listener: () => void) => () => void
  readonly log: (message: string) => void
}
