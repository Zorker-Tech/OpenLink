import type { SlateWallpaperTonePlan } from "./wallpaper-schedule-contracts.ts"

export const SLATE_WALLPAPER_PLAN_RETRY_MS = 60_000

export function delayUntilNextWallpaperBoundary(
  plan: SlateWallpaperTonePlan,
  startedAtMs: number,
  finishedAtMs: number,
): number {
  const timeSpentPainting = finishedAtMs - startedAtMs
  return Math.max(0, plan.msUntilNextBoundary - timeSpentPainting)
}
