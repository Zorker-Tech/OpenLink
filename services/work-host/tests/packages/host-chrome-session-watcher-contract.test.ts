import assert from "node:assert/strict"
import { test } from "node:test"

import {
  ChromeSessionWatcher,
  type ChromeSessionWatcherDependencies,
} from "../../source/host/boxes/box-store-sync/chrome-session-watcher.ts"
import { createDebouncePolicy, type Clock } from "../../source/host/extensions/scheduling.ts"

class TestClock implements Clock {
  private time = 0
  private readonly scheduled: Array<{ at: number; callback: () => void; active: boolean }> = []

  now(): number { return this.time }
  monotonicNow(): number { return this.time }

  schedule(delayMs: number, callback: () => void) {
    const timer = { at: this.time + delayMs, callback, active: true }
    this.scheduled.push(timer)
    return { dispose: () => { timer.active = false } }
  }

  advance(delayMs: number): void {
    this.time += delayMs
    while (true) {
      const next = this.scheduled
        .filter((timer) => timer.active && timer.at <= this.time)
        .sort((left, right) => left.at - right.at)[0]
      if (next === undefined) return
      next.active = false
      next.callback()
    }
  }
}

function watcherWorld(options: {
  readonly onChange?: () => void
  readonly startWatch?: ChromeSessionWatcherDependencies["startWatch"]
  readonly statMtimeMs?: (path: string) => number | undefined
} = {}) {
  const clock = new TestClock()
  const mtimes = new Map<string, number>([
    ["/profile/Cookies", 10],
    ["/profile/Login Data", 20],
  ])
  const logs: string[] = []
  const watchCalls: Array<{ dir: string; listener: (filename: string | null) => void }> = []
  let closeCount = 0
  let changeCount = 0
  const dependencies: ChromeSessionWatcherDependencies = {
    watchDir: "/profile",
    sessionDbNames: ["Cookies", "Login Data"],
    debounce: createDebouncePolicy(clock, { name: "test-session-watch", delayMs: 50 }),
    onSessionChange: () => { changeCount += 1; options.onChange?.() },
    startWatch: options.startWatch ?? ((dir, listener) => {
      watchCalls.push({ dir, listener })
      return { close: () => { closeCount += 1 } }
    }),
    statMtimeMs: options.statMtimeMs ?? (filePath => mtimes.get(filePath)),
    log: message => logs.push(message),
  }
  const watcher = new ChromeSessionWatcher(dependencies)

  return {
    watcher,
    clock,
    mtimes,
    logs,
    watchCalls,
    changes: () => changeCount,
    closes: () => closeCount,
  }
}

test("start snapshots existing database times and arms one watcher", () => {
  const world = watcherWorld()
  world.watcher.start()
  world.watcher.start()

  assert.equal(world.watcher.lastMtimes.get("Cookies"), 10)
  assert.equal(world.watcher.lastMtimes.get("Login Data"), 20)
  assert.equal(world.watchCalls.length, 1)
  assert.equal(world.watchCalls[0]?.dir, "/profile")
  assert.match(world.logs[0] ?? "", /watching \/profile/)
})

test("matching file events debounce to one session update", () => {
  const world = watcherWorld()
  world.watcher.start()
  const listener = world.watchCalls[0]!.listener

  assert.equal(world.watcher.isSessionDbFile("Cookies-wal"), true)
  assert.equal(world.watcher.isSessionDbFile("Preferences"), false)
  listener("Preferences")
  listener("Cookies")
  world.clock.advance(20)
  listener("Login Data")
  world.clock.advance(49)
  assert.equal(world.changes(), 0)
  world.clock.advance(1)
  assert.equal(world.changes(), 1)
})

test("an event without a filename only matters when a database timestamp advances", () => {
  const world = watcherWorld()
  world.watcher.start()
  const listener = world.watchCalls[0]!.listener

  listener(null)
  world.clock.advance(50)
  assert.equal(world.changes(), 0)

  world.mtimes.set("/profile/Cookies", 11)
  listener(null)
  world.clock.advance(50)
  assert.equal(world.changes(), 1)
  assert.equal(world.watcher.lastMtimes.get("Cookies"), 11)
})

test("stop closes the watcher and cancels a queued update", () => {
  const world = watcherWorld()
  world.watcher.start()
  const listener = world.watchCalls[0]!.listener
  listener("Cookies")
  world.watcher.stop()
  world.clock.advance(50)
  listener("Login Data")
  world.watcher.start()

  assert.equal(world.changes(), 0)
  assert.equal(world.closes(), 1)
  assert.equal(world.watchCalls.length, 1)
})

test("a watcher setup failure is logged and can be retried", () => {
  let attempts = 0
  const world = watcherWorld({
    startWatch: (dir, listener) => {
      attempts += 1
      if (attempts === 1) throw new Error("watch denied")
      worldlessWatchCalls.push({ dir, listener })
      return { close() {} }
    },
  })
  const worldlessWatchCalls: Array<{ dir: string; listener: (filename: string | null) => void }> = []

  world.watcher.start()
  world.watcher.start()
  assert.equal(attempts, 2)
  assert.match(world.logs[0] ?? "", /watch could not arm/)
  worldlessWatchCalls[0]?.listener("Cookies")
  world.clock.advance(50)
  assert.equal(world.changes(), 1)
})

test("a failing session callback is logged without escaping the watcher", () => {
  const world = watcherWorld({ onChange: () => { throw new Error("staging failed") } })
  world.watcher.start()
  world.watchCalls[0]!.listener("Cookies")

  assert.doesNotThrow(() => world.clock.advance(50))
  assert.match(world.logs.at(-1) ?? "", /onSessionChange threw.*staging failed/)
})
