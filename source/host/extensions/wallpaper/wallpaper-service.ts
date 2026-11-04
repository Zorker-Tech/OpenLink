import type { SlateWallpaperSchedulePorts, SlateWallpaperTonePlan } from "./wallpaper-schedule-contracts.ts"
import { delayUntilNextWallpaperBoundary, SLATE_WALLPAPER_PLAN_RETRY_MS } from "./wallpaper-schedule-policy.ts"

export { delayUntilNextWallpaperBoundary, SLATE_WALLPAPER_PLAN_RETRY_MS } from "./wallpaper-schedule-policy.ts"
export type { SlateWallpaperSchedulePorts, SlateWallpaperTonePlan } from "./wallpaper-schedule-contracts.ts"

export class SlateWallpaperSchedule {
  private wakeHandle: { dispose(): void } | undefined
  private removeTimeZoneListener: (() => void) | undefined
  private revision = 0
  private resolving = false
  private stopped = false

  constructor(private readonly ports: SlateWallpaperSchedulePorts) {}

  start(): void {
    this.removeTimeZoneListener = this.ports.subscribeToTimeZoneChange(() => this.requestRefresh())
    this.requestRefresh()
  }

  dispose(): void {
    this.stopped = true
    this.cancelWake()
    this.removeTimeZoneListener?.()
    this.removeTimeZoneListener = undefined
  }

  requestRefresh(): void {
    if (this.stopped) return
    this.cancelWake()
    this.revision += 1
    if (!this.resolving) void this.drainRefreshes()
  }

  private async drainRefreshes(): Promise<void> {
    this.resolving = true
    try {
      let appliedRevision = 0
      while (!this.stopped && appliedRevision !== this.revision) {
        appliedRevision = this.revision
        await this.refresh(appliedRevision)
      }
    } finally {
      this.resolving = false
    }
  }

  private cancelWake(): void {
    this.wakeHandle?.dispose()
    this.wakeHandle = undefined
  }

  private isCurrent(revision: number): boolean {
    return this.stopped || revision !== this.revision
  }

  private async refresh(revision: number): Promise<void> {
    const plan = await this.ports.resolvePlan()
    if (this.isCurrent(revision)) return
    if (plan === undefined) {
      this.scheduleRefresh(SLATE_WALLPAPER_PLAN_RETRY_MS, revision)
      return
    }

    const paintStartedAt = this.ports.clock.monotonicNow()
    await this.ports.paint()
    if (this.isCurrent(revision)) return

    const remainingMs = delayUntilNextWallpaperBoundary(
      plan,
      paintStartedAt,
      this.ports.clock.monotonicNow(),
    )
    this.ports.log(`wallpaper: painted tone ${plan.tone}; next boundary in ${Math.round(remainingMs / 1_000)}s`)
    this.scheduleRefresh(remainingMs, revision)
  }

  private scheduleRefresh(delayMs: number, revision: number): void {
    this.cancelWake()
    this.wakeHandle = this.ports.clock.schedule(delayMs, () => {
      this.wakeHandle = undefined
      if (!this.isCurrent(revision)) this.requestRefresh()
    })
  }
}
