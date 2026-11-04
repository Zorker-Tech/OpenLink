import assert from "node:assert/strict"
import { test } from "node:test"

import { BoxSettingsField, type HostSettingsMirror, type HostSettingsPort } from "../../source/shared/host-settings-field.ts"

type Settings = { theme?: string | null }

function mirrorWith(initial?: string): { mirror: HostSettingsMirror<string>; value(): string | undefined; set(value: string | undefined): void } {
  let current = initial
  return {
    mirror: { read: () => current, write: value => { current = value }, clear: () => { current = undefined } },
    value: () => current,
    set: value => { current = value },
  }
}

function settingsPort(overrides: Partial<HostSettingsPort<Settings>> = {}): HostSettingsPort<Settings> {
  return {
    isReadable: () => true,
    read: async () => ({ theme: "system" }),
    write: async update => ({ theme: update.theme ?? null }),
    ...overrides,
  }
}

test("without a mirror, reconciliation directly returns the host read", async () => {
  let readabilityAsked = false
  const field = new BoxSettingsField(settingsPort({
    isReadable: () => { readabilityAsked = true; return false },
    read: async () => ({ theme: "dark" }),
  }), "theme")
  assert.equal(await field.reconcile(), "dark")
  assert.equal(readabilityAsked, false)
})

test("a mirrored read falls back to local state when the host is unavailable or throws", async () => {
  const mirror = mirrorWith("local")
  const unreachable = new BoxSettingsField(settingsPort({ isReadable: () => false }), "theme", mirror.mirror)
  assert.equal(await unreachable.reconcile(), "local")

  const broken = new BoxSettingsField(settingsPort({ read: async () => { throw new Error("offline") } }), "theme", mirror.mirror)
  assert.equal(await broken.reconcile(), "local")
})

test("a read that races a local write returns the new mirrored value", async () => {
  let finishRead: ((value: Settings) => void) | undefined
  const staleRead = new Promise<Settings>(resolve => { finishRead = resolve })
  const mirror = mirrorWith()
  const field = new BoxSettingsField(settingsPort({ read: () => staleRead }), "theme", mirror.mirror)
  const reconciliation = field.reconcile()

  assert.deepEqual(await field.apply("dark"), { status: "persisted", value: "dark" })
  finishRead?.({ theme: "old" })
  assert.equal(await reconciliation, "dark")
})

test("apply updates the local mirror first and distinguishes a saved echo from an unreachable host", async () => {
  const writes: Array<Partial<Settings>> = []
  const mirror = mirrorWith()
  const field = new BoxSettingsField(settingsPort({
    write: async update => { writes.push(update); return { theme: null } },
  }), "theme", mirror.mirror)
  assert.deepEqual(await field.apply("dark"), { status: "persisted", value: null })
  assert.equal(mirror.value(), "dark")
  assert.deepEqual(writes, [{ theme: "dark" }])

  const unreachable = new BoxSettingsField(settingsPort({ write: async () => null }), "theme", mirror.mirror)
  assert.deepEqual(await unreachable.apply("light"), { status: "unreachable" })
  assert.equal(mirror.value(), "light")
})

test("box values backfill an empty mirror, repaint a differing one, and leave matching values alone", async () => {
  const source = settingsPort({ read: async () => ({ theme: "blue" }) })
  const empty = mirrorWith()
  assert.equal(await new BoxSettingsField(source, "theme", empty.mirror).absorbFromBox(), "backfilled")
  assert.equal(empty.value(), "blue")

  const stale = mirrorWith("red")
  assert.equal(await new BoxSettingsField(source, "theme", stale.mirror).absorbFromBox(), "repainted")
  assert.equal(stale.value(), "blue")

  const same = mirrorWith("blue")
  assert.equal(await new BoxSettingsField(source, "theme", same.mirror).absorbFromBox(), "none")
})

test("a missing box value clears an untouched mirror and only backfills a later divergence", async () => {
  let hostValue: Settings = {}
  const writes: Array<Partial<Settings>> = []
  const source = settingsPort({
    read: async () => hostValue,
    write: async update => { writes.push(update); hostValue = { ...hostValue, ...update }; return hostValue },
  })
  const untouched = mirrorWith("old")
  assert.equal(await new BoxSettingsField(source, "theme", untouched.mirror).absorbFromBox(), "cleared")
  assert.equal(untouched.value(), undefined)

  const local = mirrorWith("chosen")
  const field = new BoxSettingsField(source, "theme", local.mirror)
  assert.deepEqual(await field.apply("chosen"), { status: "persisted", value: "chosen" })
  hostValue = {}
  local.set("changed-locally")
  assert.equal(await field.absorbFromBox(), "none")
  assert.equal(hostValue.theme, "changed-locally")
  assert.deepEqual(writes, [{ theme: "chosen" }, { theme: "changed-locally" }])
})
