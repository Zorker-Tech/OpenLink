import assert from "node:assert/strict"
import { test } from "node:test"

import {
  DEFAULT_WATCH_TIMEOUT_MS,
  ListenerConnectWatcher,
} from "../../source/host/automations/listener-connect-watcher.ts"

type CheckResult = boolean | Error | Promise<boolean>

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

function settle(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0))
}

function watcherWorld(checks: CheckResult[], options: {
  readonly now?: number
  readonly watchTimeoutMs?: number
} = {}) {
  let now = options.now ?? 1_000
  let pollDisposals = 0
  const pollTicks: Array<() => Promise<void>> = []
  const checkCalls: string[] = []
  const connected: string[] = []
  const watcher = new ListenerConnectWatcher({
    polling: {
      name: "test-listener-watch",
      start(tick: () => Promise<void>) {
        pollTicks.push(tick)
        return { dispose() { pollDisposals += 1 } }
      },
    },
    isPlatformConnected: async platform => {
      checkCalls.push(platform)
      const result = checks.shift()
      if (result instanceof Error) throw result
      return await Promise.resolve(result ?? false)
    },
    onConnected: (agentId, platform) => { connected.push(`${agentId}:${platform}`) },
    ...(options.watchTimeoutMs === undefined ? {} : { watchTimeoutMs: options.watchTimeoutMs }),
    now: () => now,
  })

  return {
    watcher,
    pollTicks,
    checkCalls,
    connected,
    setNow(value: number) { now = value },
    pollDisposals: () => pollDisposals,
  }
}

test("a watch arms only after a disconnected check, then reports the later connection once", async () => {
  const world = watcherWorld([false, true])
  world.watcher.watch("agent-a", "calendar" as never)
  await settle()
  assert.deepEqual(world.connected, [])

  await world.watcher.tick()
  assert.deepEqual(world.connected, ["agent-a:calendar"])
  assert.equal(world.watcher.pending.size, 0)
  assert.equal(world.pollDisposals(), 1)
})

test("an already connected platform and an expired watch do not produce a notice", async () => {
  const alreadyConnected = watcherWorld([true])
  alreadyConnected.watcher.watch("agent-a", "calendar" as never)
  await settle()
  assert.deepEqual(alreadyConnected.connected, [])
  assert.equal(alreadyConnected.watcher.pending.size, 0)

  const timedOut = watcherWorld([false], { now: 10, watchTimeoutMs: 25 })
  timedOut.watcher.watch("agent-b", "mail" as never)
  await settle()
  timedOut.setNow(35)
  await timedOut.watcher.tick()
  assert.deepEqual(timedOut.connected, [])
  assert.equal(timedOut.watcher.pending.size, 0)
})

test("a failed connection check remains pending but does not arm a notice", async () => {
  const world = watcherWorld([new Error("listener status unavailable"), false, true])
  world.watcher.watch("agent-a", "calendar" as never)
  await settle()
  assert.equal(world.watcher.pending.size, 1)
  assert.deepEqual(world.connected, [])

  await world.watcher.tick()
  assert.deepEqual(world.connected, [])
  await world.watcher.tick()
  assert.deepEqual(world.connected, ["agent-a:calendar"])
})

test("suspension keeps watches pending and resumes with a fresh check", async () => {
  const world = watcherWorld([false])
  world.watcher.suspend()
  world.watcher.watch("agent-a", "calendar" as never)
  await settle()
  assert.equal(world.checkCalls.length, 0)
  assert.equal(world.watcher.pending.size, 1)

  world.watcher.resume()
  await settle()
  assert.equal(world.checkCalls.length, 1)
  assert.equal(world.watcher.pending.size, 1)
})

test("a replacement watch does not inherit an in-flight result from the previous agent", async () => {
  const firstCheck = deferred<boolean>()
  const world = watcherWorld([firstCheck.promise, false, true])
  world.watcher.watch("old-agent", "calendar" as never)
  world.watcher.watch("new-agent", "calendar" as never)
  firstCheck.resolve(false)
  await settle()

  await world.watcher.tick()
  assert.deepEqual(world.connected, [])
  await world.watcher.tick()
  assert.deepEqual(world.connected, ["new-agent:calendar"])
})

test("dispose clears pending work and stops the polling loop", async () => {
  const world = watcherWorld([false, true])
  world.watcher.watch("agent-a", "calendar" as never)
  await settle()
  world.watcher.dispose()
  await world.watcher.tick()

  assert.equal(world.pollDisposals(), 1)
  assert.equal(world.watcher.pending.size, 0)
  assert.deepEqual(world.connected, [])
  assert.equal(world.checkCalls.length, 1)
  assert.equal(DEFAULT_WATCH_TIMEOUT_MS, 15 * 60 * 1_000)
})
