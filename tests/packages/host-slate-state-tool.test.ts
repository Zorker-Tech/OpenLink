import { test } from "node:test"
import assert from "node:assert/strict"

import {
  ACTIONS,
  OPERATIONS,
  TARGETS,
  applySlateStateUpdate,
  describeStateUpdate,
  isSlateStateRoute,
  resolveTrigger,
  slateUpdateStateParameters,
  createSlateStateTool,
  type SlateStateDependencies,
  type SlateStateUpdate,
} from "../../source/host/runner/tools/slate-state-tool.ts"
import { SlateToolInputError } from "../../source/host/runner/tools/tool-input-error.ts"

const automations = [
  { id: "a1", name: "Daily", prompt: "do the thing", trigger: { type: "cron", schedule: "@daily" }, isEnabled: true },
  { id: "a2", name: "Watch", prompt: "watch wf-1 and report", trigger: { type: "slack", channel: "#eng" }, isEnabled: false },
]
const workflows = [
  { id: "wf-1", name: "Deploy", body: "steps" },
  { id: "wf-2", name: "Review", body: "steps" },
]

const makeDeps = (overrides: Partial<SlateStateDependencies> = {}) => {
  const calls: Array<[string, unknown]> = []
  const state: Record<string, unknown> = {}
  for (const method of ["writeMemory", "removeMemory", "createAutomation", "updateAutomation", "setAutomationEnabled", "deleteAutomation", "writeWorkflow", "deleteWorkflow", "updateProfile", "updateSettings", "disconnectChannel", "createProject", "joinProject", "leaveProject", "setAvatar"]) {
    state[method] = async (args: unknown) => { calls.push([method, args]); return { ok: true, detail: method + ":done" } }
  }
  state.clearAvatar = async () => { calls.push(["clearAvatar", null]); return { ok: true, detail: "clearAvatar:done" } }
  const deps = { state, toolCallId: "call-1", automationStore: { list: () => automations }, workflowStore: { list: () => workflows }, ...overrides } as SlateStateDependencies
  return { calls, deps }
}

const apply = (args: SlateStateUpdate, overrides: Partial<SlateStateDependencies> = {}) => {
  const { calls, deps } = makeDeps(overrides)
  return { calls, run: () => applySlateStateUpdate(args, deps) }
}

test("every target and action is a route, and nothing else is", () => {
  for (const target of TARGETS) {
    assert.equal(target in OPERATIONS, true)
    for (const action of Object.keys(OPERATIONS[target])) assert.equal(isSlateStateRoute(target + "." + action), true, target + "." + action)
  }
  assert.equal(ACTIONS.length > 0, true)
  assert.equal(isSlateStateRoute("memory.write"), true)
  assert.equal(isSlateStateRoute("memory.nope"), false)
  assert.equal(isSlateStateRoute("nope.write"), false)
  assert.equal(isSlateStateRoute("memory"), false)
  assert.equal(isSlateStateRoute("toString.call"), false, "inherited object methods are not routes")
})

test("the arguments are the state update the tool documents", () => {
  assert.equal(slateUpdateStateParameters.safeParse({ target: "memory", action: "write", fact: "f" }).success, true)
  assert.equal(slateUpdateStateParameters.safeParse({ target: "routine", action: "create", name: "r", prompt: "p", schedule: "0 7 * * *" }).success, true)
  assert.equal(slateUpdateStateParameters.safeParse({ target: "routine", action: "create", name: "r", prompt: "p", trigger: [{ type: "cron", schedule: "@daily" }] }).success, true)
  assert.equal(slateUpdateStateParameters.safeParse({ target: "routine", action: "nope" }).success, false)
  assert.equal(slateUpdateStateParameters.safeParse({ target: "memory", action: "write" }).success, true, "the fields a route requires are checked when it runs, not by the schema")
})

test("a routine's trigger is a schedule, one trigger, several, or a fallback", () => {
  assert.deepEqual(resolveTrigger({ schedule: "0 7 * * *" } as unknown as SlateStateUpdate, makeDeps().deps), { type: "cron", schedule: "0 7 * * *" })
  assert.deepEqual(resolveTrigger({ trigger: { type: "cron", schedule: "@daily" } } as unknown as SlateStateUpdate, makeDeps().deps), { type: "cron", schedule: "@daily" })
  assert.deepEqual(resolveTrigger({ trigger: [{ type: "cron", schedule: "@daily" }, { type: "slack", channel: "#eng" }] } as unknown as SlateStateUpdate, makeDeps().deps), { type: "group", listeners: [{ type: "cron", schedule: "@daily" }, { type: "slack", channel: "#eng" }] })
  assert.deepEqual(resolveTrigger({} as unknown as SlateStateUpdate, makeDeps().deps, { type: "cron", schedule: "@weekly" }), { type: "cron", schedule: "@weekly" })
  assert.throws(() => resolveTrigger({ schedule: "0 7 * * *", trigger: { type: "cron" } } as unknown as SlateStateUpdate, makeDeps().deps), SlateToolInputError)
  assert.throws(() => resolveTrigger({} as unknown as SlateStateUpdate, makeDeps().deps), SlateToolInputError)
  assert.throws(() => resolveTrigger({ trigger: { type: "cron", schedule: "@daily" } } as unknown as SlateStateUpdate, makeDeps({ parseTrigger: () => null }).deps), SlateToolInputError)
})

test("a state update writes through the writer it is given", async () => {
  const memory = apply({ target: "memory", action: "write", fact: "f" })
  assert.deepEqual(await memory.run(), { ok: true, detail: "writeMemory:done" })
  assert.deepEqual(memory.calls, [["writeMemory", { content: "f", tier: "log", scope: "agent" }]])
  const paused = apply({ target: "routine", action: "pause", id: "a1" })
  await paused.run()
  assert.deepEqual(paused.calls, [["setAutomationEnabled", { id: "a1", isEnabled: false }]])
  const created = apply({ target: "routine", action: "create", name: "New", prompt: "p", schedule: "0 7 * * *" })
  await created.run()
  assert.equal((created.calls[0]?.[1] as { spec: { isEnabled?: boolean; trigger: unknown } }).spec.isEnabled, true)
  assert.deepEqual((created.calls[0]?.[1] as { spec: { trigger: unknown } }).spec.trigger, { type: "cron", schedule: "0 7 * * *" })
  const avatar = apply({ target: "avatar", action: "clear" })
  await avatar.run()
  assert.deepEqual(avatar.calls, [["clearAvatar", null]])
})

test("memory ownership and tier are explicit at the writer boundary", async () => {
  const project = apply({ target: "memory", action: "write", fact: "Project decision", scope: "project", project: "slate" })
  await project.run()
  assert.deepEqual(project.calls, [["writeMemory", { content: "Project decision", tier: "log", scope: "project", project: "slate" }]])

  const profile = apply({ target: "memory", action: "write", fact: "Preferred name", tier: "profile", scope: "user" })
  await profile.run()
  assert.deepEqual(profile.calls, [["writeMemory", { content: "Preferred name", tier: "profile", scope: "user" }]])

  const forgotten = apply({ target: "memory", action: "forget", fact: "Exact stored text", scope: "user" })
  await forgotten.run()
  assert.deepEqual(forgotten.calls, [["removeMemory", { content: "Exact stored text", scope: "user" }]])
})

test("routine updates keep omitted fields and only send an enabled change when requested", async () => {
  const calls: Array<[string, unknown]> = []
  let reviewed: unknown
  const deps = makeDeps({
    state: {
      updateAutomation: async (args: Parameters<SlateStateDependencies["state"]["updateAutomation"]>[0]) => {
        calls.push(["updateAutomation", args]);
        return { ok: true, detail: "updated" };
      },
    } as unknown as SlateStateDependencies["state"],
    automationStore: { list: () => [automations[0]!] },
    reviewAutomationWrite: async (review) => { reviewed = review; return { allowed: true, reason: "" } },
  }).deps

  const result = await applySlateStateUpdate({ target: "routine", action: "update", id: "a1", prompt: "new instruction" }, deps)
  assert.deepEqual(result, { ok: true, detail: "updated" })
  assert.deepEqual(calls, [["updateAutomation", {
    id: "a1",
    spec: { name: "Daily", prompt: "new instruction", trigger: { type: "cron", schedule: "@daily" } },
  }]])
  assert.deepEqual(reviewed, {
    operation: "update",
    id: "a1",
    spec: { name: "Daily", prompt: "new instruction", trigger: { type: "cron", schedule: "@daily" } },
    referencedWorkflows: [],
  })
})

test("a listener is registered only after the routine write succeeds", async () => {
  let listenerRegistrations = 0
  const deps = makeDeps({
    state: {
      createAutomation: async () => ({ ok: false, reason: "storage unavailable" }),
    } as unknown as SlateStateDependencies["state"],
    onListenerRoutineSaved: async () => { listenerRegistrations += 1; return "listener saved" },
  }).deps

  const result = await applySlateStateUpdate({ target: "routine", action: "create", name: "Watch", prompt: "watch changes", schedule: "@daily" }, deps)
  assert.deepEqual(result, { ok: false, reason: "storage unavailable" })
  assert.equal(listenerRegistrations, 0)
})

test("workflow creation leaves id allocation to the writer and reviews referenced routines", async () => {
  const created = apply({ target: "workflow", action: "write", name: "Release Notes", description: "When preparing a release", body: "Collect changes." })
  await created.run()
  assert.deepEqual(created.calls, [["writeWorkflow", { name: "Release Notes", description: "When preparing a release", body: "Collect changes." }]])

  let writes = 0
  let reviewed = 0
  const deps = makeDeps({
    state: {
      writeWorkflow: async () => { writes += 1; return { ok: true, detail: "saved" } },
    } as unknown as SlateStateDependencies["state"],
    automationStore: { list: () => [automations[1]!] },
    reviewAutomationWrite: async (review) => {
      reviewed += 1
      assert.deepEqual(review.referencingRoutines, [{ id: "a2", name: "Watch", prompt: "watch wf-1 and report" }])
      return { allowed: false, reason: "review required" }
    },
  }).deps
  const refused = await applySlateStateUpdate({ target: "workflow", action: "write", id: "wf-1", name: "Deploy", description: "d", body: "changed" }, deps)
  assert.deepEqual(refused, { ok: false, reason: "review required" })
  assert.equal(reviewed, 1)
  assert.equal(writes, 0)
})

test("a missing required field is a tool input error, not a write", async () => {
  const { calls, run } = apply({ target: "channel", action: "disconnect" })
  await assert.rejects(run(), (error: Error) => error instanceof SlateToolInputError)
  assert.deepEqual(calls, [])
  await assert.rejects(applySlateStateUpdate({ target: "memory", action: "nope" } as unknown as unknown as SlateStateUpdate, makeDeps().deps), SlateToolInputError)
  await assert.rejects(applySlateStateUpdate({ target: "unknown", action: "write" } as unknown as SlateStateUpdate, makeDeps().deps), SlateToolInputError)
  await assert.rejects(applySlateStateUpdate({ target: "toString", action: "call" } as unknown as SlateStateUpdate, makeDeps().deps), SlateToolInputError)
})

test("a routine update needs the routine, and a review that refuses stops the write", async () => {
  await assert.rejects(apply({ target: "routine", action: "update", id: "gone", prompt: "p" }).run(), /no routine with folder "gone" exists/)
  const refused = apply({ target: "routine", action: "create", name: "New", prompt: "p", schedule: "0 7 * * *" }, {
    reviewAutomationWrite: async () => ({ allowed: false, reason: "needs approval" }),
  })
  assert.deepEqual(await refused.run(), { ok: false, reason: "needs approval" })
  const { deps } = makeDeps({ onListenerRoutineSaved: async () => "listener saved" })
  const noted = await applySlateStateUpdate({ target: "routine", action: "create", name: "New", prompt: "p", schedule: "0 7 * * *" } as unknown as SlateStateUpdate, deps)
  assert.deepEqual(noted, { ok: true, detail: "createAutomation:done\nlistener saved" })
})

test("a workflow write is reviewed when a routine references it, and says what it did", async () => {
  const reviewed = apply({ target: "workflow", action: "write", name: "Deploy", description: "d", body: "b", id: "wf-1" }, {
    reviewAutomationWrite: async (review) => { assert.equal(review.operation, "workflow_body"); return { allowed: true, reason: "" } },
  })
  await reviewed.run()
  assert.deepEqual(reviewed.calls.map(([name]) => name), ["writeWorkflow"])
  await assert.rejects(apply({ target: "workflow", action: "write", name: "n", body: "b" }).run(), SlateToolInputError)
  const reviews: string[] = []
  const renamed = apply({ target: "workflow", action: "write", id: "wf-2", name: "Renamed", description: "d", body: "b" }, {
    automationStore: { list: () => [{ id: "r1", name: "Reviewer", prompt: "please use the Review workflow", trigger: { type: "cron", schedule: "@daily" }, isEnabled: true }] },
    reviewAutomationWrite: async (review) => { reviews.push(review.operation); return { allowed: true, reason: "" } },
  })
  await renamed.run()
  assert.deepEqual(reviews, ["workflow_body"], "the routine that references the old name still needs the review")
  assert.equal(describeStateUpdate({ target: "memory", action: "write", scope: "user" } as unknown as SlateStateUpdate), "user memory")
  assert.equal(describeStateUpdate({ target: "routine", action: "update", name: "N", id: "i" } as unknown as SlateStateUpdate), "N")
  assert.equal(describeStateUpdate({ target: "project", action: "join", project: "p" } as unknown as SlateStateUpdate), "p")
  const tool = createSlateStateTool(makeDeps().deps) as { name?: string; descriptionGenerator?: () => string }
  assert.equal(tool.name, "update_state")
  assert.match(tool.descriptionGenerator?.() ?? "", /target \+ action:/)
  assert.match(tool.descriptionGenerator?.() ?? "", /- routine create: /)
})
