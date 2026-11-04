import assert from "node:assert/strict"
import { test } from "node:test"

import { SlateWallpaperSchedule } from "../../source/host/extensions/wallpaper/wallpaper-service.ts"
import type { Clock } from "../../source/host/extensions/scheduling.ts"

function fakeClock() {
  const timers: Array<{ delay: number; callback: () => void; disposed: boolean }> = []
  const clock: Clock = {
    now: () => 1_000,
    monotonicNow: () => elapsed,
    schedule(delay, callback) {
      const timer = { delay, callback, disposed: false }
      timers.push(timer)
      return { dispose() { timer.disposed = true } }
    },
  }
  let elapsed = 10_000
  return {
    clock,
    timers,
    advance(milliseconds: number) { elapsed += milliseconds },
    fire(index: number) {
      const timer = timers[index]
      if (timer !== undefined && !timer.disposed) timer.callback()
    },
  }
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve))

test("an unresolved tone plan retries once per minute and disposal cancels the retry", async () => {
  const time = fakeClock()
  let resolves = 0
  let unsubscribes = 0
  const scheduler = new SlateWallpaperSchedule({
    clock: time.clock,
    resolvePlan: async () => (resolves += 1, undefined),
    paint: async () => {},
    subscribeToTimeZoneChange: () => () => { unsubscribes += 1 },
    log: () => {},
  })

  scheduler.start()
  await settle()
  assert.equal(resolves, 1)
  assert.deepEqual(time.timers.map(({ delay }) => delay), [60_000])
  scheduler.dispose()
  assert.equal(time.timers[0]?.disposed, true)
  assert.equal(unsubscribes, 1)
  time.fire(0)
  await settle()
  assert.equal(resolves, 1)
})

test("a paint schedules from the remaining boundary time and logs rounded seconds", async () => {
  const time = fakeClock()
  const messages: string[] = []
  const scheduler = new SlateWallpaperSchedule({
    clock: time.clock,
    resolvePlan: async () => ({ tone: "dawn", msUntilNextBoundary: 10_000 }),
    paint: async () => time.advance(2_500),
    subscribeToTimeZoneChange: () => () => {},
    log: (message) => messages.push(message),
  })

  scheduler.start()
  await settle()
  assert.deepEqual(time.timers.map(({ delay }) => delay), [7_500])
  assert.deepEqual(messages, ["wallpaper: painted tone dawn; next boundary in 8s"])
  scheduler.dispose()
})

test("a time-zone change supersedes a pending schedule and reads a fresh plan", async () => {
  const time = fakeClock()
  let change: (() => void) | undefined
  let resolves = 0
  const scheduler = new SlateWallpaperSchedule({
    clock: time.clock,
    resolvePlan: async () => (resolves += 1, resolves === 1 ? { tone: "old", msUntilNextBoundary: 5_000 } : undefined),
    paint: async () => {},
    subscribeToTimeZoneChange: (listener) => (change = listener, () => {}),
    log: () => {},
  })

  scheduler.start()
  await settle()
  change?.()
  await settle()

  assert.equal(time.timers[0]?.disposed, true)
  assert.equal(resolves, 2)
  assert.deepEqual(time.timers.map(({ delay }) => delay), [5_000, 60_000])
  scheduler.dispose()
})

test("a newer refresh arriving during plan resolution skips the stale paint", async () => {
  const time = fakeClock()
  let change: (() => void) | undefined
  let releaseFirst!: (value: { tone: string; msUntilNextBoundary: number }) => void
  let resolutions = 0
  const paints: string[] = []
  const scheduler = new SlateWallpaperSchedule({
    clock: time.clock,
    resolvePlan: async () => {
      resolutions += 1
      if (resolutions === 1) return await new Promise((resolve) => { releaseFirst = resolve })
      return { tone: "current", msUntilNextBoundary: 1_000 }
    },
    paint: async () => { paints.push(resolutions === 1 ? "stale" : "current") },
    subscribeToTimeZoneChange: (listener) => (change = listener, () => {}),
    log: () => {},
  })

  scheduler.start()
  await settle()
  change?.()
  releaseFirst({ tone: "stale", msUntilNextBoundary: 50_000 })
  await settle()
  await settle()
  assert.deepEqual(paints, ["current"])
  assert.deepEqual(time.timers.map(({ delay }) => delay), [1_000])
  scheduler.dispose()
})

test("disposal while a plan is pending prevents painting or scheduling", async () => {
  const time = fakeClock()
  let release!: (value: { tone: string; msUntilNextBoundary: number }) => void
  let paints = 0
  const scheduler = new SlateWallpaperSchedule({
    clock: time.clock,
    resolvePlan: async () => await new Promise((resolve) => { release = resolve }),
    paint: async () => { paints += 1 },
    subscribeToTimeZoneChange: () => () => {},
    log: () => {},
  })

  scheduler.start()
  await settle()
  scheduler.dispose()
  release({ tone: "late", msUntilNextBoundary: 1_000 })
  await settle()
  assert.equal(paints, 0)
  assert.equal(time.timers.length, 0)
})
