import assert from "node:assert/strict"
import { test } from "node:test"

import {
  bestEffortAccessToken,
  managedSetupExtension,
  startManagedSkillsWhenAuthenticated,
  type ManagedAuthPort,
  type ManagedSetupContext,
  type RenewalEvent,
} from "../../source/host/extensions/managed-setup/extension.ts"

function authFixture(initialToken: string | null = null) {
  let token = initialToken
  const renewalListeners: Array<(event: RenewalEvent) => void> = []
  let changeListener: (() => void) | undefined
  let unsubscribed = 0
  const auth: ManagedAuthPort = {
    async getAccessToken() { return token ?? "" },
    getMachineId: () => "machine-1",
    peekAccessToken: () => token,
    subscribeToRenewal(listener) {
      renewalListeners.push(listener)
      return () => { unsubscribed += 1 }
    },
    onDidChange(listener) {
      changeListener = listener
      return () => { unsubscribed += 1 }
    },
  }
  return {
    auth,
    setToken(value: string | null) { token = value },
    emit(event: RenewalEvent) { for (const listener of renewalListeners) listener(event) },
    change() { changeListener?.() },
    unsubscribeCount: () => unsubscribed,
  }
}

test("token access is best effort and treats an empty credential as unavailable", async () => {
  let received: unknown
  assert.equal(await bestEffortAccessToken({
    async getAccessToken(args) { received = args; return " token " },
  }, { backendUrl: "https://service.invalid" })(), " token ")
  assert.deepEqual(received, { backendUrl: "https://service.invalid" })
  assert.equal(await bestEffortAccessToken({ async getAccessToken() { return "" } })(), null)
  assert.equal(await bestEffortAccessToken({ async getAccessToken() { throw new Error("signed out") } })(), null)
})

test("managed skills start on the first usable credential and refresh only for a new credential", () => {
  const world = authFixture()
  let starts = 0
  let refreshes = 0
  const stop = startManagedSkillsWhenAuthenticated({
    auth: world.auth,
    startManagedSkills: () => { starts += 1 },
    refreshManagedSkills: () => { refreshes += 1 },
  })

  world.emit({ outcome: "renewed", isFirstCredential: true })
  assert.equal(starts, 0)
  world.setToken("access-token")
  world.emit({ outcome: "renewed", isFirstCredential: true })
  world.emit({ outcome: "renewed", isFirstCredential: true })
  world.emit({ outcome: "renewed", isFirstCredential: false })
  world.emit({ outcome: "failed", isFirstCredential: true })
  assert.deepEqual([starts, refreshes], [1, 1])

  stop()
  world.emit({ outcome: "renewed", isFirstCredential: true })
  assert.deepEqual([starts, refreshes, world.unsubscribeCount()], [1, 1, 1])
})

test("legacy change events can start the service and disposal closes that subscription", () => {
  let token: string | null = null
  let listener: (() => void) | undefined
  let unsubscribed = 0
  let starts = 0
  let refreshes = 0
  const auth = {
    getAccessToken: async () => token ?? "",
    getMachineId: () => "machine-1",
    peekAccessToken: () => token,
    onDidChange(callback: () => void) { listener = callback; return () => { unsubscribed += 1 } },
  } as ManagedAuthPort
  const stop = startManagedSkillsWhenAuthenticated({
    auth,
    startManagedSkills: () => { starts += 1 },
    refreshManagedSkills: () => { refreshes += 1 },
  })

  token = "access-token"
  listener?.()
  listener?.()
  assert.deepEqual([starts, refreshes], [1, 1])
  stop()
  listener?.()
  assert.deepEqual([starts, refreshes, unsubscribed], [1, 1, 1])
})

test("the extension wires service ports, replays the last renewal and disposes its owned services", async () => {
  const world = authFixture("access-token")
  world.auth.getLastRenewalEvent = () => ({ outcome: "renewed", isFirstCredential: true })
  const calls: string[] = []
  const reports: unknown[] = []
  let stopListener: (() => void) | undefined
  let getAccessToken: (() => Promise<string | null>) | undefined
  const service = {
    start() { calls.push("skills-start") },
    onAuthenticationReady() { calls.push("skills-refresh") },
    dispose() { calls.push("skills-dispose") },
    async ensureSkillIsCached(id: string) { calls.push(`ensure:${id}`); return true },
  }
  const rules = {
    start() { calls.push("rules-start") },
    refresh() { calls.push("rules-refresh") },
    async resolveRules() { return ["rule"] as const },
  }
  const context: ManagedSetupContext = {
    deps: { auth: world.auth, telemetry: { logs: { reportHostExtensionDiagnostic: event => reports.push(event) } } },
    createManagedSkills(args) { getAccessToken = args.getAccessToken; args.report({ kind: "created" }); return service as never },
    createTeamRules(args) { args.report({ kind: "rules-created" }); return rules },
    async fetchSkillCatalog(token) { return [{ token: await token() }] },
    onStop(dispose) { stopListener = dispose },
  }

  const api = managedSetupExtension.start(context)
  assert.deepEqual(calls, ["skills-start", "rules-refresh", "rules-start"])
  assert.deepEqual(reports, [{ kind: "created" }, { kind: "rules-created" }])
  assert.deepEqual(await api.skillsCatalog(), [{ token: "access-token" }])
  assert.equal(await api.ensureManagedSkill("skill-a"), true)
  assert.deepEqual(await api.resolveTeamRules(), ["rule"])
  assert.deepEqual(calls.slice(-2), ["rules-start", "ensure:skill-a"])
  api.dispose()
  assert.deepEqual(calls.slice(-2), ["ensure:skill-a", "skills-dispose"])
  assert.equal(typeof stopListener, "function")
  assert.equal(typeof getAccessToken, "function")
  stopListener?.()
})
