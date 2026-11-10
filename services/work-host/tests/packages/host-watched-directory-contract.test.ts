import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { test } from "node:test"

import type { DebouncePolicy } from "../../source/host/extensions/scheduling.ts"
import { WatchedDirectory } from "../../source/host/watched-directory.ts"

function debounceHarness(): {
  readonly policy: DebouncePolicy
  readonly disposedCount: () => number
} {
  let disposed = 0
  const policy: DebouncePolicy = {
    name: "test",
    wrap<Args extends unknown[]>(callback: (...args: Args) => void) {
      let active = true
      const wrapped = ((...args: Args) => {
        if (active) callback(...args)
      }) as ((...args: Args) => void) & { dispose(): void }
      wrapped.dispose = () => {
        active = false
        disposed += 1
      }
      return wrapped
    },
  }
  return { policy, disposedCount: () => disposed }
}

test("subdirectory listing is sorted and omits files, with an empty result for a missing root", () => {
  const root = mkdtempSync(path.join(tmpdir(), "slate-watch-list-"))
  try {
    mkdirSync(path.join(root, "zeta"))
    mkdirSync(path.join(root, "alpha"))
    writeFileSync(path.join(root, "readme.txt"), "file")
    const watched = new WatchedDirectory(root, debounceHarness().policy)
    assert.equal(watched.getLocation(), root)
    assert.deepEqual(watched.listSubdirectoryNames(), ["alpha", "zeta"])
    assert.deepEqual(new WatchedDirectory(path.join(root, "missing"), debounceHarness().policy).listSubdirectoryNames(), [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("atomic writes create parents, replace contents and leave no staging file", () => {
  const root = mkdtempSync(path.join(tmpdir(), "slate-watch-write-"))
  try {
    const target = path.join(root, "nested", "state.json")
    const watched = new WatchedDirectory(root, debounceHarness().policy)
    watched.writeFileAtomic(target, "first")
    watched.writeFileAtomic(target, "second")

    assert.equal(readFileSync(target, "utf8"), "second")
    assert.deepEqual(readdirSync(path.dirname(target)), ["state.json"])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("change listeners are replaced and disposed when watching stops", () => {
  const root = mkdtempSync(path.join(tmpdir(), "slate-watch-listener-"))
  const debounce = debounceHarness()
  try {
    const watched = new WatchedDirectory(root, debounce.policy)
    let oldCalls = 0
    let newCalls = 0
    watched.setOnChange(() => oldCalls++)
    watched.scheduleNotify()
    watched.setOnChange(() => newCalls++)
    watched.scheduleNotify()
    assert.equal(oldCalls, 1)
    assert.equal(newCalls, 1)
    assert.equal(debounce.disposedCount(), 1)

    watched.setOnChange(null)
    watched.scheduleNotify()
    assert.equal(newCalls, 1)
    assert.equal(debounce.disposedCount(), 2)
    watched.stopWatching()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("watch setup failures are reported to the caller", () => {
  const root = mkdtempSync(path.join(tmpdir(), "slate-watch-failure-"))
  try {
    const file = path.join(root, "file")
    writeFileSync(file, "not a directory")
    const failures: unknown[] = []
    const watched = new WatchedDirectory(path.join(file, "child"), debounceHarness().policy, error => failures.push(error))
    watched.startWatching()
    assert.equal(failures.length, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
